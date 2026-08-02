from __future__ import annotations

import math
import re
import tomllib
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from rapidfuzz import fuzz


ALIAS_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MIN_FUZZY_LENGTH = 4
MIN_FUZZY_SIMILARITY = 65.0
MIN_FUZZY_MARGIN = 15.0


class VoiceRouterError(ValueError):
    """Raised when router input or configuration is invalid."""


@dataclass(frozen=True)
class AliasProfile:
    match_phrases: tuple[str, ...] = ()
    voice: str | None = None
    rate: int | None = None


@dataclass(frozen=True)
class RouterConfig:
    wake_words: tuple[str, ...] = ("hey",)
    profiles: dict[str, AliasProfile] = field(default_factory=dict)


@dataclass(frozen=True)
class RouteResult:
    alias: str | None
    question: str | None
    reason: str
    similarity: float | None = None
    runner_up_similarity: float | None = None

    @property
    def accepted(self) -> bool:
        return self.alias is not None and self.question is not None


@dataclass(frozen=True)
class _Token:
    key: str
    start: int
    end: int


def resolve_config_path(home: Path, xdg_config_home: str | None) -> Path:
    if xdg_config_home:
        root = Path(xdg_config_home)
        if not root.is_absolute():
            raise VoiceRouterError("XDG_CONFIG_HOME must be an absolute path")
    else:
        root = home / ".config"
    return root / "llm-now" / "voice-router.toml"


def parse_inventory(text: str) -> tuple[str, ...]:
    aliases: list[str] = []
    seen_aliases: set[str] = set()
    seen_keys: dict[str, str] = {}

    for line_number, row in enumerate(text.splitlines(), start=1):
        if not row:
            continue
        if "\x1b" in row or row.count(" → ") != 1:
            raise VoiceRouterError(f"invalid alias inventory row {line_number}")
        alias, presentation = row.split(" → ", 1)
        if (
            not ALIAS_PATTERN.fullmatch(alias)
            or presentation.count(" · ") != 1
            or any(not part for part in presentation.split(" · ", 1))
        ):
            raise VoiceRouterError(f"invalid alias inventory row {line_number}")
        if alias in seen_aliases:
            raise VoiceRouterError(f'duplicate alias in inventory: "{alias}"')

        key = compact_key(alias)
        collision = seen_keys.get(key)
        if collision is not None:
            raise VoiceRouterError(
                f'aliases "{collision}" and "{alias}" collide after routing normalization'
            )
        seen_aliases.add(alias)
        seen_keys[key] = alias
        aliases.append(alias)

    if not aliases:
        raise VoiceRouterError("alias inventory is empty")
    return tuple(aliases)


def parse_config(data: bytes | None, aliases: Iterable[str]) -> RouterConfig:
    active_aliases = _validated_aliases(aliases)
    if data is None:
        return RouterConfig()

    try:
        document = tomllib.loads(data.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise VoiceRouterError(f"invalid voice router configuration: {error}") from error

    wake_value = document.pop("wake_words", ["hey"])
    wake_words = _string_list(wake_value, "wake_words", allow_empty_list=True)
    _validate_phrases(wake_words, "wake_words")

    profiles: dict[str, AliasProfile] = {}
    allowed_profile_fields = {"match_phrases", "voice", "rate"}
    for alias, raw_profile in document.items():
        if not ALIAS_PATTERN.fullmatch(alias):
            raise VoiceRouterError(f'invalid profile alias: "{alias}"')
        if not isinstance(raw_profile, dict):
            raise VoiceRouterError(f'profile "{alias}" must be a TOML table')

        unknown = sorted(set(raw_profile) - allowed_profile_fields)
        if unknown:
            raise VoiceRouterError(
                f'unknown profile field for "{alias}": {", ".join(unknown)}'
            )

        phrases = _string_list(
            raw_profile.get("match_phrases", []),
            f'{alias}.match_phrases',
            allow_empty_list=True,
        )
        _validate_phrases(phrases, f'{alias}.match_phrases')

        voice_value = raw_profile.get("voice")
        if voice_value is not None and (
            not isinstance(voice_value, str) or not voice_value.strip()
        ):
            raise VoiceRouterError(f'{alias}.voice must be a nonempty string')

        rate_value = raw_profile.get("rate")
        if rate_value is not None and (
            isinstance(rate_value, bool)
            or not isinstance(rate_value, int)
            or not 80 <= rate_value <= 500
        ):
            raise VoiceRouterError(f'{alias}.rate must be an integer from 80 through 500')

        profiles[alias] = AliasProfile(
            match_phrases=phrases,
            voice=voice_value.strip() if isinstance(voice_value, str) else None,
            rate=rate_value,
        )

    _validate_active_phrases(profiles, active_aliases)
    return RouterConfig(wake_words=wake_words, profiles=profiles)


def route_transcript(
    transcript: str,
    aliases: Iterable[str],
    config: RouterConfig,
) -> RouteResult:
    active_aliases = _validated_aliases(aliases)
    tokens = _tokenize(transcript)
    if not tokens:
        return RouteResult(None, None, "missing_request")

    canonical_by_key = {compact_key(alias): alias for alias in active_aliases}
    phrase_by_key: dict[str, str] = {}
    for alias in active_aliases:
        profile = config.profiles.get(alias)
        if profile is None:
            continue
        for phrase in profile.match_phrases:
            phrase_by_key[compact_key(phrase)] = alias

    views = _transcript_views(tokens, config.wake_words)
    saw_missing_question = False
    strongest_rejection: RouteResult | None = None

    for start in views:
        exact = _longest_stage_match(transcript, tokens, start, canonical_by_key, "canonical")
        if exact is not None:
            if exact.accepted:
                return exact
            saw_missing_question = True
            continue

        configured = _longest_stage_match(
            transcript, tokens, start, phrase_by_key, "configured"
        )
        if configured is not None:
            if configured.accepted:
                return configured
            saw_missing_question = True
            continue

        fuzzy = _fuzzy_match(transcript, tokens, start, canonical_by_key)
        if fuzzy.accepted:
            return fuzzy
        if fuzzy.reason == "ambiguous":
            strongest_rejection = fuzzy

    if saw_missing_question:
        return RouteResult(None, None, "missing_question")
    return strongest_rejection or RouteResult(None, None, "no_match")


def compact_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def _validated_aliases(aliases: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    keys: dict[str, str] = {}
    for alias in aliases:
        if not isinstance(alias, str) or not ALIAS_PATTERN.fullmatch(alias):
            raise VoiceRouterError(f'invalid canonical alias: "{alias}"')
        key = compact_key(alias)
        collision = keys.get(key)
        if collision is not None:
            raise VoiceRouterError(
                f'aliases "{collision}" and "{alias}" collide after routing normalization'
            )
        keys[key] = alias
        result.append(alias)
    return tuple(result)


def _string_list(value: object, field_name: str, *, allow_empty_list: bool) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise VoiceRouterError(f"{field_name} must be a list of strings")
    if not allow_empty_list and not value:
        raise VoiceRouterError(f"{field_name} must not be empty")
    return tuple(value)


def _validate_phrases(phrases: Iterable[str], field_name: str) -> None:
    seen: set[str] = set()
    for phrase in phrases:
        key = compact_key(phrase)
        if not key:
            raise VoiceRouterError(f"{field_name} contains a blank normalized phrase")
        if key in seen:
            raise VoiceRouterError(f"{field_name} contains a duplicate phrase")
        seen.add(key)


def _validate_active_phrases(
    profiles: dict[str, AliasProfile], active_aliases: tuple[str, ...]
) -> None:
    canonical_by_key = {compact_key(alias): alias for alias in active_aliases}
    phrase_owners: dict[str, str] = {}
    for alias in active_aliases:
        profile = profiles.get(alias)
        if profile is None:
            continue
        for phrase in profile.match_phrases:
            key = compact_key(phrase)
            canonical_owner = canonical_by_key.get(key)
            if canonical_owner is not None and canonical_owner != alias:
                raise VoiceRouterError(
                    f'match phrase "{phrase}" for "{alias}" collides with canonical alias '
                    f'"{canonical_owner}"'
                )
            phrase_owner = phrase_owners.get(key)
            if phrase_owner is not None and phrase_owner != alias:
                raise VoiceRouterError(
                    f'match phrase "{phrase}" is shared by "{phrase_owner}" and "{alias}"'
                )
            phrase_owners[key] = alias


def _is_word_character(character: str) -> bool:
    return character.isalnum() or unicodedata.category(character).startswith("M")


def _tokenize(value: str) -> tuple[_Token, ...]:
    tokens: list[_Token] = []
    start: int | None = None

    def finish(end: int) -> None:
        nonlocal start
        if start is None:
            return
        key = compact_key(value[start:end])
        if key:
            tokens.append(_Token(key=key, start=start, end=end))
        start = None

    for index, character in enumerate(value):
        if _is_word_character(character):
            if start is None:
                start = index
        else:
            finish(index)
    finish(len(value))
    return tuple(tokens)


def _phrase_token_keys(phrase: str) -> tuple[str, ...]:
    return tuple(token.key for token in _tokenize(phrase))


def _transcript_views(tokens: tuple[_Token, ...], wake_words: tuple[str, ...]) -> tuple[int, ...]:
    wake_lengths: list[int] = []
    token_keys = tuple(token.key for token in tokens)
    for phrase in wake_words:
        phrase_keys = _phrase_token_keys(phrase)
        if phrase_keys and token_keys[: len(phrase_keys)] == phrase_keys:
            wake_lengths.append(len(phrase_keys))

    views: list[int] = []
    if wake_lengths:
        views.append(max(wake_lengths))
    views.append(0)
    return tuple(dict.fromkeys(views))


def _question_after(transcript: str, end: int) -> str | None:
    question_start = end
    while question_start < len(transcript) and not _is_word_character(
        transcript[question_start]
    ):
        question_start += 1
    question = transcript[question_start:]
    return question if _tokenize(question) else None


def _longest_stage_match(
    transcript: str,
    tokens: tuple[_Token, ...],
    start: int,
    aliases_by_key: dict[str, str],
    reason: str,
) -> RouteResult | None:
    winner: tuple[int, str] | None = None
    key = ""
    for end in range(start + 1, len(tokens) + 1):
        key += tokens[end - 1].key
        alias = aliases_by_key.get(key)
        if alias is not None:
            winner = (end, alias)

    if winner is None:
        return None
    end, alias = winner
    question = _question_after(transcript, tokens[end - 1].end)
    if question is None:
        return RouteResult(None, None, "missing_question")
    return RouteResult(alias, question, reason)


def _digit_sequences(value: str) -> tuple[str, ...]:
    return tuple(re.findall(r"\d+", value))


def _fuzzy_match(
    transcript: str,
    tokens: tuple[_Token, ...],
    start: int,
    canonical_by_key: dict[str, str],
) -> RouteResult:
    per_alias: dict[str, tuple[float, int, str]] = {}
    candidate_key = ""

    for end in range(start + 1, len(tokens) + 1):
        candidate_key += tokens[end - 1].key
        question = _question_after(transcript, tokens[end - 1].end)
        if question is None or len(candidate_key) < MIN_FUZZY_LENGTH:
            continue

        for alias_key, alias in canonical_by_key.items():
            if len(alias_key) < MIN_FUZZY_LENGTH:
                continue
            max_difference = max(1, math.ceil(len(alias_key) * 0.2))
            if abs(len(candidate_key) - len(alias_key)) > max_difference:
                continue
            if (_digit_sequences(candidate_key) or _digit_sequences(alias_key)) and (
                _digit_sequences(candidate_key) != _digit_sequences(alias_key)
            ):
                continue

            score = float(fuzz.ratio(candidate_key, alias_key, processor=None))
            current = per_alias.get(alias)
            span_length = end - start
            if current is None or score > current[0] or (
                score == current[0] and span_length < current[1]
            ):
                per_alias[alias] = (score, span_length, question)

    if not per_alias:
        return RouteResult(None, None, "no_match")

    ranked = sorted(
        ((score, alias, span_length, question) for alias, (score, span_length, question) in per_alias.items()),
        key=lambda item: (-item[0], item[1]),
    )
    best_score, best_alias, _span_length, best_question = ranked[0]
    runner_up = ranked[1][0] if len(ranked) > 1 else None
    if best_score < MIN_FUZZY_SIMILARITY:
        return RouteResult(None, None, "no_match", best_score, runner_up)
    if runner_up is not None and best_score - runner_up < MIN_FUZZY_MARGIN:
        return RouteResult(None, None, "ambiguous", best_score, runner_up)
    return RouteResult(best_alias, best_question, "fuzzy", best_score, runner_up)


def main() -> int:
    raise SystemExit("voice orchestration is not implemented yet")
