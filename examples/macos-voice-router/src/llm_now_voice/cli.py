from __future__ import annotations

import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import tomllib
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Protocol, TextIO

from rapidfuzz import fuzz


ALIAS_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
STORED_ALIAS_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
PROVIDER_IDS = frozenset(
    {
        "anthropic",
        "openai",
        "google",
        "xai",
        "openrouter",
        "groq",
        "mistral",
        "deepseek",
        "deepinfra",
        "ollama",
        "lm-studio",
        "codex-cli",
        "claude-cli",
    }
)
DEFAULT_MODEL_PROVIDERS = frozenset({"codex-cli", "claude-cli"})
MIN_FUZZY_LENGTH = 4
MIN_FUZZY_SIMILARITY = 65.0
MIN_FUZZY_MARGIN = 15.0
INVENTORY_TIMEOUT = 5
GENERATION_TIMEOUT = 50
CLIPBOARD_TIMEOUT = 5
SPEECH_TIMEOUT = 120
RETRY_NOTICE = b"I couldn't match an alias and question. Please try again."
REQUEST_FAILED_NOTICE = b"The request failed. Please try again."
CONFIG_FAILED_NOTICE = b"The voice router needs attention. Check the Shortcut result."
COPY_FAILED_NOTICE = b"I couldn't copy the answer. Check the Shortcut result."
CONCISE_PROMPT = (
    "Answer concisely in plain text suitable for speech. "
    "Do not use Markdown or code fences unless the question requires code."
)


class VoiceRouterError(ValueError):
    """Raised when router input or configuration is invalid."""


class ProcessCancelled(Exception):
    """Raised after cancellation stops and reaps an active process group."""


class ProcessTimedOut(Exception):
    def __init__(self, args: tuple[str, ...], timeout: float) -> None:
        super().__init__(f"command timed out after {timeout:g} seconds: {args[0]}")
        self.command = args
        self.timeout = timeout


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes = b""
    stderr: bytes = b""


class ProcessRunner(Protocol):
    def run(
        self, args: tuple[str, ...], input_data: bytes | None, timeout: float
    ) -> ProcessResult: ...


class SubprocessRunner:
    def __init__(
        self,
        *,
        popen: Callable[..., object] = subprocess.Popen,
        killpg: Callable[[int, int], None] = os.killpg,
    ) -> None:
        self._popen = popen
        self._killpg = killpg
        self._cancelled = threading.Event()
        self._lock = threading.RLock()
        self._active: object | None = None

    def run(
        self, args: tuple[str, ...], input_data: bytes | None, timeout: float
    ) -> ProcessResult:
        if self._cancelled.is_set():
            raise ProcessCancelled()

        process = self._popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            start_new_session=True,
        )
        with self._lock:
            self._active = process
            cancelled_after_spawn = self._cancelled.is_set()
        if cancelled_after_spawn:
            self._terminate_and_reap(process)
            self._clear_active(process)
            raise ProcessCancelled()

        try:
            try:
                stdout, stderr = process.communicate(input=input_data, timeout=timeout)
            except subprocess.TimeoutExpired as error:
                self._terminate_and_reap(process)
                raise ProcessTimedOut(args, timeout) from error
            if self._cancelled.is_set():
                raise ProcessCancelled()
            return ProcessResult(process.returncode, stdout, stderr)
        finally:
            self._clear_active(process)

    def cancel(self) -> None:
        self._cancelled.set()
        with self._lock:
            process = self._active
        if process is None or process.poll() is not None:
            return
        try:
            self._killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        if process.poll() is None:
            try:
                self._killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def _clear_active(self, process: object) -> None:
        with self._lock:
            if self._active is process:
                self._active = None

    def _terminate_and_reap(self, process: object) -> None:
        if process.poll() is None:
            try:
                self._killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            process.communicate(timeout=1)
            return
        except subprocess.TimeoutExpired:
            pass

        if process.poll() is None:
            try:
                self._killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.communicate()


@dataclass(frozen=True)
class AliasProfile:
    match_phrases: tuple[str, ...] = ()
    voice: str | None = None
    rate: int | None = None
    pitch: int | float | None = None


@dataclass(frozen=True)
class RouterConfig:
    wake_words: tuple[str, ...] = ("hey",)
    min_fuzzy_phrase_length: int = MIN_FUZZY_LENGTH
    min_similarity: int = int(MIN_FUZZY_SIMILARITY)
    min_margin: int = int(MIN_FUZZY_MARGIN)
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
    configured = Path(xdg_config_home) if xdg_config_home else None
    root = configured if configured is not None and configured.is_absolute() else home / ".config"
    return root / "llm-now" / "config.toml"


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


def parse_voice_inventory(text: str) -> dict[str, str]:
    voices: dict[str, str] = {}
    row_pattern = re.compile(r"^(.+?)\s+([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)+)\s+#")
    for line_number, row in enumerate(text.splitlines(), start=1):
        if not row:
            continue
        match = row_pattern.match(row)
        if match is None:
            raise VoiceRouterError(f"invalid macOS voice inventory row {line_number}")
        voice = match.group(1).strip()
        key = voice.casefold()
        if not voice or key in voices:
            raise VoiceRouterError(f'duplicate macOS voice: "{voice}"')
        voices[key] = voice
    if not voices:
        raise VoiceRouterError("macOS voice inventory is empty")
    return voices


def parse_config(data: bytes | None, aliases: Iterable[str]) -> RouterConfig:
    active_aliases = _validated_aliases(aliases)
    if data is None:
        return RouterConfig()

    try:
        document = tomllib.loads(data.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise VoiceRouterError(f"invalid voice router configuration: {error}") from error

    unknown_root_fields = sorted(set(document) - {"version", "voice", "aliases"})
    if unknown_root_fields:
        raise VoiceRouterError(
            f'unknown configuration field at root: {", ".join(unknown_root_fields)}'
        )
    if type(document.get("version")) is not int or document["version"] != 1:
        raise VoiceRouterError("unsupported configuration version")

    raw_voice = document.get("voice", {})
    if not isinstance(raw_voice, dict):
        raise VoiceRouterError("voice must be a TOML table")
    unknown_voice_fields = sorted(
        set(raw_voice)
        - {"wake_words", "min_fuzzy_phrase_length", "min_similarity", "min_margin"}
    )
    if unknown_voice_fields:
        raise VoiceRouterError(
            f'unknown configuration field at voice: {", ".join(unknown_voice_fields)}'
        )

    wake_value = raw_voice.get("wake_words", ["hey"])
    wake_words = _string_list(wake_value, "voice.wake_words")
    _validate_phrases(wake_words, "wake_words")
    min_fuzzy_phrase_length = _integer_in_range(
        raw_voice.get("min_fuzzy_phrase_length", MIN_FUZZY_LENGTH),
        "voice.min_fuzzy_phrase_length",
        1,
        64,
    )
    min_similarity = _integer_in_range(
        raw_voice.get("min_similarity", int(MIN_FUZZY_SIMILARITY)),
        "voice.min_similarity",
        0,
        100,
    )
    min_margin = _integer_in_range(
        raw_voice.get("min_margin", int(MIN_FUZZY_MARGIN)),
        "voice.min_margin",
        0,
        100,
    )

    raw_aliases = document.get("aliases")
    if not isinstance(raw_aliases, dict):
        raise VoiceRouterError("aliases must be a TOML table")

    profiles: dict[str, AliasProfile] = {}
    canonical_names: dict[str, str] = {}
    routing_names: dict[str, str] = {}
    allowed_alias_fields = {
        "provider",
        "model",
        "instructions",
        "match_phrases",
        "voice",
        "rate",
        "pitch",
    }
    for original_alias, raw_profile in raw_aliases.items():
        if not isinstance(original_alias, str) or not STORED_ALIAS_PATTERN.fullmatch(
            original_alias
        ):
            raise VoiceRouterError("invalid alias name")
        alias = original_alias.lower()
        if alias in canonical_names:
            raise VoiceRouterError(f'duplicate case-insensitive alias: "{alias}"')
        routing_name = compact_key(alias)
        collision = routing_names.get(routing_name)
        if collision is not None:
            raise VoiceRouterError(
                f'aliases "{collision}" and "{alias}" collide after routing normalization'
            )
        canonical_names[alias] = original_alias
        routing_names[routing_name] = alias

        if not isinstance(raw_profile, dict):
            raise VoiceRouterError(f'alias "{alias}" must be a TOML table')

        unknown = sorted(set(raw_profile) - allowed_alias_fields)
        if unknown:
            raise VoiceRouterError(
                f'unknown configuration field at aliases.{alias}: {", ".join(unknown)}'
            )

        provider = raw_profile.get("provider")
        if not isinstance(provider, str) or provider not in PROVIDER_IDS:
            raise VoiceRouterError(f"aliases.{alias}.provider is unsupported")
        model = raw_profile.get("model")
        if not isinstance(model, str) or not model.strip():
            raise VoiceRouterError(f"aliases.{alias}.model must be a nonempty string")
        if model == "default" and provider not in DEFAULT_MODEL_PROVIDERS:
            raise VoiceRouterError(
                f"aliases.{alias}.model cannot use default for this provider"
            )

        instructions = raw_profile.get("instructions")
        if instructions is not None:
            _validate_instructions(instructions)

        phrases = _string_list(
            raw_profile.get("match_phrases", []),
            f"aliases.{alias}.match_phrases",
        )
        _validate_phrases(phrases, f"aliases.{alias}.match_phrases")

        voice_value = raw_profile.get("voice")
        if voice_value is not None and (
            not isinstance(voice_value, str) or not voice_value.strip()
        ):
            raise VoiceRouterError(f"aliases.{alias}.voice must be a nonempty string")

        rate_value = raw_profile.get("rate")
        if rate_value is not None and (
            isinstance(rate_value, bool)
            or not isinstance(rate_value, int)
            or not 80 <= rate_value <= 500
        ):
            raise VoiceRouterError(
                f"aliases.{alias}.rate must be an integer from 80 through 500"
            )

        pitch_value = raw_profile.get("pitch")
        if pitch_value is not None and (
            isinstance(pitch_value, bool)
            or not isinstance(pitch_value, (int, float))
            or (isinstance(pitch_value, float) and not math.isfinite(pitch_value))
            or not 1 <= pitch_value <= 127
        ):
            raise VoiceRouterError(
                f"aliases.{alias}.pitch must be a number from 1 through 127"
            )

        profiles[alias] = AliasProfile(
            match_phrases=phrases,
            voice=voice_value.strip() if isinstance(voice_value, str) else None,
            rate=rate_value,
            pitch=pitch_value,
        )

    _validate_active_phrases(profiles, tuple(profiles))
    _validate_active_phrases(profiles, active_aliases)
    return RouterConfig(
        wake_words=wake_words,
        min_fuzzy_phrase_length=min_fuzzy_phrase_length,
        min_similarity=min_similarity,
        min_margin=min_margin,
        profiles=profiles,
    )


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

        fuzzy = _fuzzy_match(transcript, tokens, start, canonical_by_key, config)
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


def _string_list(value: object, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise VoiceRouterError(f"{field_name} must be a list of strings")
    return tuple(value)


def _integer_in_range(value: object, field_name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise VoiceRouterError(
            f"{field_name} must be an integer from {minimum} through {maximum}"
        )
    return value


def _validate_instructions(value: object) -> None:
    if not isinstance(value, str) or not value.strip():
        raise VoiceRouterError("instructions must be a nonempty string")
    for character in value:
        code_point = ord(character)
        if (
            code_point <= 9
            or 11 <= code_point <= 31
            or 127 <= code_point <= 159
            or code_point in (0x2028, 0x2029)
        ):
            raise VoiceRouterError("instructions contain unsupported control characters")


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

    return (max(wake_lengths), 0) if wake_lengths else (0,)


def _longest_stage_match(
    transcript: str,
    tokens: tuple[_Token, ...],
    start: int,
    aliases_by_key: dict[str, str],
    reason: str,
) -> RouteResult | None:
    winner: tuple[int, str] | None = None
    key = ""
    maximum_key_length = max((len(candidate) for candidate in aliases_by_key), default=0)
    for end in range(start + 1, len(tokens) + 1):
        key += tokens[end - 1].key
        if len(key) > maximum_key_length:
            break
        alias = aliases_by_key.get(key)
        if alias is not None:
            winner = (end, alias)

    if winner is None:
        return None
    end, alias = winner
    if end >= len(tokens):
        return RouteResult(None, None, "missing_question")
    question = transcript[tokens[end].start :]
    return RouteResult(alias, question, reason)


def _digit_sequences(value: str) -> tuple[str, ...]:
    return tuple(re.findall(r"\d+", value))


def _fuzzy_match(
    transcript: str,
    tokens: tuple[_Token, ...],
    start: int,
    canonical_by_key: dict[str, str],
    config: RouterConfig,
) -> RouteResult:
    per_alias: dict[str, tuple[float, int, str]] = {}
    candidate_key = ""
    alias_metadata = tuple(
        (
            alias_key,
            alias,
            max(1, math.ceil(len(alias_key) * 0.2)),
            _digit_sequences(alias_key),
        )
        for alias_key, alias in canonical_by_key.items()
        if len(alias_key) >= config.min_fuzzy_phrase_length
    )
    maximum_candidate_length = max(
        (len(alias_key) + max_difference for alias_key, _alias, max_difference, _digits in alias_metadata),
        default=0,
    )

    for end in range(start + 1, len(tokens) + 1):
        candidate_key += tokens[end - 1].key
        if len(candidate_key) > maximum_candidate_length:
            break
        if end >= len(tokens) or len(candidate_key) < config.min_fuzzy_phrase_length:
            continue
        question = transcript[tokens[end].start :]
        candidate_digits = _digit_sequences(candidate_key)

        for alias_key, alias, max_difference, alias_digits in alias_metadata:
            if abs(len(candidate_key) - len(alias_key)) > max_difference:
                continue
            if (candidate_digits or alias_digits) and candidate_digits != alias_digits:
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
        ((score, alias, question) for alias, (score, _span_length, question) in per_alias.items()),
        key=lambda item: (-item[0], item[1]),
    )
    best_score, best_alias, best_question = ranked[0]
    runner_up = ranked[1][0] if len(ranked) > 1 else None
    if best_score < config.min_similarity:
        return RouteResult(None, None, "no_match", best_score, runner_up)
    if runner_up is not None and best_score - runner_up < config.min_margin:
        return RouteResult(None, None, "ambiguous", best_score, runner_up)
    return RouteResult(best_alias, best_question, "fuzzy", best_score, runner_up)


def run_voice_router(
    transcript_data: bytes,
    *,
    runner: ProcessRunner,
    config_data: bytes | None = None,
    stderr: TextIO,
    llm_now: str = "llm-now",
    pbcopy: str = "/usr/bin/pbcopy",
    say: str = "/usr/bin/say",
    command_available: Callable[[str], bool] | None = None,
) -> int:
    try:
        if command_available is not None:
            missing = next(
                (command for command in (llm_now, pbcopy, say) if not command_available(command)),
                None,
            )
            if missing is not None:
                _write_diagnostic(stderr, f"required command is unavailable: {missing}")
                if missing == say:
                    return 1
                _speak_notice(runner, say, CONFIG_FAILED_NOTICE, stderr)
                return 1

        try:
            transcript = transcript_data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            _write_diagnostic(stderr, "dictated transcript is not valid UTF-8")
            return 0 if _speak_notice(runner, say, RETRY_NOTICE, stderr) else 1

        try:
            inventory_result = runner.run((llm_now, "--aliases"), None, INVENTORY_TIMEOUT)
        except FileNotFoundError:
            _write_diagnostic(stderr, f"required command is unavailable: {llm_now}")
            _speak_notice(runner, say, CONFIG_FAILED_NOTICE, stderr)
            return 1
        except (ProcessTimedOut, OSError) as error:
            _write_diagnostic(stderr, f"alias inventory failed: {error}")
            return 0 if _speak_notice(runner, say, RETRY_NOTICE, stderr) else 1

        _write_child_diagnostic(stderr, "alias inventory", inventory_result.stderr)
        if inventory_result.returncode != 0:
            _write_diagnostic(
                stderr, f"alias inventory exited with status {inventory_result.returncode}"
            )
            return 0 if _speak_notice(runner, say, RETRY_NOTICE, stderr) else 1
        try:
            aliases = parse_inventory(
                inventory_result.stdout.decode("utf-8", errors="strict")
            )
        except (UnicodeDecodeError, VoiceRouterError) as error:
            _write_diagnostic(stderr, f"invalid alias inventory: {error}")
            return 0 if _speak_notice(runner, say, RETRY_NOTICE, stderr) else 1

        try:
            config = parse_config(config_data, aliases)
        except VoiceRouterError as error:
            _write_diagnostic(stderr, str(error))
            _speak_notice(runner, say, CONFIG_FAILED_NOTICE, stderr)
            return 1

        route = route_transcript(transcript, aliases, config)
        if not route.accepted:
            _write_diagnostic(stderr, f"request rejected: {route.reason}")
            return 0 if _speak_notice(runner, say, RETRY_NOTICE, stderr) else 1

        alias = route.alias
        question = route.question
        assert alias is not None and question is not None
        profile = config.profiles.get(alias, AliasProfile())

        installed_voice: str | None = None
        if profile.voice is not None:
            try:
                voice_result = runner.run((say, "-v", "?"), None, INVENTORY_TIMEOUT)
            except (FileNotFoundError, ProcessTimedOut, OSError) as error:
                _write_diagnostic(stderr, f"macOS voice inventory failed: {error}")
                _speak_notice(runner, say, CONFIG_FAILED_NOTICE, stderr)
                return 1
            _write_child_diagnostic(stderr, "macOS voice inventory", voice_result.stderr)
            if voice_result.returncode != 0:
                _write_diagnostic(
                    stderr,
                    f"macOS voice inventory exited with status {voice_result.returncode}",
                )
                _speak_notice(runner, say, CONFIG_FAILED_NOTICE, stderr)
                return 1
            try:
                voices = parse_voice_inventory(
                    voice_result.stdout.decode("utf-8", errors="strict")
                )
            except (UnicodeDecodeError, VoiceRouterError) as error:
                _write_diagnostic(stderr, f"invalid macOS voice inventory: {error}")
                _speak_notice(runner, say, CONFIG_FAILED_NOTICE, stderr)
                return 1
            installed_voice = voices.get(profile.voice.casefold())
            if installed_voice is None:
                _write_diagnostic(
                    stderr, f'configured voice is not installed: "{profile.voice}"'
                )
                _speak_notice(runner, say, CONFIG_FAILED_NOTICE, stderr)
                return 1

        prompt = f"{CONCISE_PROMPT}\n\n{question}".encode("utf-8")
        try:
            generation = runner.run(
                (llm_now, "--alias", alias), prompt, GENERATION_TIMEOUT
            )
        except FileNotFoundError:
            _write_diagnostic(stderr, f"required command is unavailable: {llm_now}")
            _speak_notice(runner, say, CONFIG_FAILED_NOTICE, stderr)
            return 1
        except (ProcessTimedOut, OSError) as error:
            _write_diagnostic(stderr, f"model request failed: {error}")
            return 0 if _speak_notice(runner, say, REQUEST_FAILED_NOTICE, stderr) else 1

        _write_child_diagnostic(stderr, "model request", generation.stderr)
        if generation.returncode != 0:
            _write_diagnostic(
                stderr, f"model request exited with status {generation.returncode}"
            )
            return 0 if _speak_notice(runner, say, REQUEST_FAILED_NOTICE, stderr) else 1

        try:
            answer_text = generation.stdout.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            _write_diagnostic(stderr, "model response is not valid UTF-8")
            return 0 if _speak_notice(runner, say, REQUEST_FAILED_NOTICE, stderr) else 1
        if not answer_text.strip():
            _write_diagnostic(stderr, "model response is empty")
            return 0 if _speak_notice(runner, say, REQUEST_FAILED_NOTICE, stderr) else 1
        if _unsafe_for_speech(answer_text):
            _write_diagnostic(stderr, "model response contains unsafe speech controls")
            return 0 if _speak_notice(runner, say, REQUEST_FAILED_NOTICE, stderr) else 1

        answer = generation.stdout
        try:
            copy_result = runner.run((pbcopy,), answer, CLIPBOARD_TIMEOUT)
        except (FileNotFoundError, ProcessTimedOut, OSError) as error:
            _write_diagnostic(stderr, f"clipboard copy failed: {error}")
            _speak_notice(runner, say, COPY_FAILED_NOTICE, stderr)
            return 1
        _write_child_diagnostic(stderr, "clipboard copy", copy_result.stderr)
        if copy_result.returncode != 0:
            _write_diagnostic(
                stderr, f"clipboard copy exited with status {copy_result.returncode}"
            )
            _speak_notice(runner, say, COPY_FAILED_NOTICE, stderr)
            return 1

        speech_args = [say]
        if installed_voice is not None:
            speech_args.extend(("-v", installed_voice))
        if profile.rate is not None:
            speech_args.extend(("-r", str(profile.rate)))
        speech = answer
        if profile.pitch is not None:
            pitch_command = f"[[pbas {_format_pitch(profile.pitch)}]]".encode("ascii")
            speech = pitch_command + answer
        try:
            speech_result = runner.run(tuple(speech_args), speech, SPEECH_TIMEOUT)
        except (FileNotFoundError, ProcessTimedOut, OSError) as error:
            _write_diagnostic(stderr, f"answer speech failed: {error}")
            return 1
        _write_child_diagnostic(stderr, "answer speech", speech_result.stderr)
        if speech_result.returncode != 0:
            _write_diagnostic(
                stderr, f"answer speech exited with status {speech_result.returncode}"
            )
            return 1
        return 0
    except ProcessCancelled:
        _write_diagnostic(stderr, "voice request cancelled")
        return 130


def _unsafe_for_speech(value: str) -> bool:
    if "[[" in value or "\x1b" in value:
        return True
    return any(
        unicodedata.category(character) == "Cc" and character not in "\t\n\r"
        for character in value
    )


def _format_pitch(value: int | float) -> str:
    if isinstance(value, int) or value.is_integer():
        return str(int(value))
    return str(value)


def _speak_notice(
    runner: ProcessRunner, say: str, notice: bytes, stderr: TextIO
) -> bool:
    try:
        result = runner.run((say,), notice, SPEECH_TIMEOUT)
    except ProcessCancelled:
        raise
    except (FileNotFoundError, ProcessTimedOut, OSError) as error:
        _write_diagnostic(stderr, f"notice speech failed: {error}")
        return False
    _write_child_diagnostic(stderr, "notice speech", result.stderr)
    if result.returncode != 0:
        _write_diagnostic(stderr, f"notice speech exited with status {result.returncode}")
        return False
    return True


def _write_child_diagnostic(stderr: TextIO, label: str, data: bytes) -> None:
    if data:
        text = data.decode("utf-8", errors="replace").strip()
        if text:
            _write_diagnostic(stderr, f"{label}: {text}")


def _write_diagnostic(stderr: TextIO, message: str) -> None:
    safe = message.replace("\x1b", "")
    safe = "".join(
        character
        for character in safe
        if character in "\t\n\r" or unicodedata.category(character) != "Cc"
    )
    if len(safe) > 2048:
        safe = f"{safe[:2047]}…"
    stderr.write(f"{safe.rstrip()}\n")


def _command_available(command: str) -> bool:
    return shutil.which(command) is not None


def main() -> int:
    if sys.platform != "darwin":
        _write_diagnostic(sys.stderr, "llm-now-voice currently supports macOS only.")
        return 1

    runner = SubprocessRunner()

    def cancel(_signum: int, _frame: object) -> None:
        runner.cancel()

    previous_handlers: dict[int, object] = {}
    for current_signal in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[current_signal] = signal.signal(current_signal, cancel)

    try:
        try:
            config_path = resolve_config_path(
                Path.home(), os.environ.get("XDG_CONFIG_HOME")
            )
            try:
                config_data = config_path.read_bytes()
            except FileNotFoundError:
                config_data = None
            transcript_data = sys.stdin.buffer.read()
        except (OSError, VoiceRouterError) as error:
            _write_diagnostic(sys.stderr, f"voice router setup failed: {error}")
            _speak_notice(runner, "/usr/bin/say", CONFIG_FAILED_NOTICE, sys.stderr)
            return 1

        return run_voice_router(
            transcript_data,
            runner=runner,
            config_data=config_data,
            stderr=sys.stderr,
            command_available=_command_available,
        )
    finally:
        for current_signal, previous_handler in previous_handlers.items():
            signal.signal(current_signal, previous_handler)
