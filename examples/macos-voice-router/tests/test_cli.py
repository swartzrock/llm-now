from __future__ import annotations

import unittest

from llm_now_voice.cli import (
    VoiceRouterError,
    parse_config,
    parse_inventory,
    route_transcript,
)


ALIASES = ("deepseek32", "fred", "haiku", "local", "opus47", "qwen", "terra")


class InventoryTests(unittest.TestCase):
    def test_parses_documented_rows_without_provider_semantics(self) -> None:
        text = (
            "deepseek32 → OpenRouter · deepseek/deepseek-v3.2\n"
            "terra → Codex CLI · gpt-5.6-terra\n"
        )

        self.assertEqual(parse_inventory(text), ("deepseek32", "terra"))

    def test_ignores_blank_lines(self) -> None:
        self.assertEqual(parse_inventory("\nhaiku → Anthropic · claude-haiku\n\n"), ("haiku",))

    def test_rejects_empty_malformed_duplicate_and_normalization_collisions(self) -> None:
        invalid = (
            "",
            "haiku: Anthropic / claude-haiku\n",
            "haiku → Anthropic · \n",
            "haiku → Anthropic · one\nhaiku → Anthropic · two\n",
            "deep-seek → One · model\ndeep_seek → Two · model\n",
            "\x1b[31mhaiku → Anthropic · model\n",
        )

        for text in invalid:
            with self.subTest(text=text), self.assertRaises(VoiceRouterError):
                parse_inventory(text)


class ConfigTests(unittest.TestCase):
    def test_missing_config_uses_default_wake_word_and_empty_profiles(self) -> None:
        config = parse_config(None, ALIASES)

        self.assertEqual(config.wake_words, ("hey",))
        self.assertEqual(config.profiles, {})

    def test_parses_flat_alias_profiles(self) -> None:
        config = parse_config(
            b'''wake_words = ["hey", "computer"]

[terra]
match_phrases = ["tara"]
voice = "Samantha"
rate = 205

[opus47]
match_phrases = ["op 47"]
''',
            ALIASES,
        )

        self.assertEqual(config.wake_words, ("hey", "computer"))
        self.assertEqual(config.profiles["terra"].match_phrases, ("tara",))
        self.assertEqual(config.profiles["terra"].voice, "Samantha")
        self.assertEqual(config.profiles["terra"].rate, 205)

    def test_stale_profiles_are_inert_but_still_structurally_validated(self) -> None:
        config = parse_config(
            b'''[retired]
match_phrases = ["terra"]
voice = "Old Voice"
rate = 180
''',
            ALIASES,
        )

        self.assertIn("retired", config.profiles)

        with self.assertRaisesRegex(VoiceRouterError, "unknown profile field"):
            parse_config(b"[retired]\nvolume = 10\n", ALIASES)

    def test_rejects_invalid_root_profile_and_phrase_values(self) -> None:
        invalid = (
            b"enabled = true\n",
            b'wake_words = "hey"\n',
            b'wake_words = [""]\n',
            b"[terra]\nmatch_phrases = 'tara'\n",
            b"[terra]\nmatch_phrases = ['...']\n",
            b"[terra]\nvoice = ''\n",
            b"[terra]\nrate = 79\n",
            b"[terra]\nrate = 501\n",
            b"[terra]\nrate = true\n",
            b"[wake_words]\nvoice = 'Samantha'\n",
        )

        for data in invalid:
            with self.subTest(data=data), self.assertRaises(VoiceRouterError):
                parse_config(data, ALIASES)

    def test_rejects_active_duplicate_and_canonical_phrase_collisions(self) -> None:
        with self.assertRaisesRegex(VoiceRouterError, "match phrase"):
            parse_config(
                b"[terra]\nmatch_phrases = ['tara']\n[fred]\nmatch_phrases = ['tara']\n",
                ALIASES,
            )

        with self.assertRaisesRegex(VoiceRouterError, "canonical alias"):
            parse_config(b"[qwen]\nmatch_phrases = ['terra']\n", ALIASES)


class RoutingTests(unittest.TestCase):
    def assert_route(
        self,
        transcript: str,
        expected_alias: str,
        expected_question: str,
        expected_reason: str,
        *,
        aliases: tuple[str, ...] = ALIASES,
        config_data: bytes | None = None,
    ) -> None:
        config = parse_config(config_data, aliases)
        result = route_transcript(transcript, aliases, config)

        self.assertTrue(result.accepted)
        self.assertEqual(result.alias, expected_alias)
        self.assertEqual(result.question, expected_question)
        self.assertEqual(result.reason, expected_reason)

    def test_compact_exact_match_preserves_original_question(self) -> None:
        self.assert_route(
            "Deep seek 32, explain mixture of experts",
            "deepseek32",
            "explain mixture of experts",
            "canonical",
        )

    def test_exact_match_is_casefolded_and_prefers_longest_boundary(self) -> None:
        self.assert_route(
            "HAIKU, write a love poem",
            "haiku",
            "write a love poem",
            "canonical",
            aliases=("hai", "haiku"),
        )

    def test_unicode_compatibility_normalization_matches_alias(self) -> None:
        self.assert_route(
            "Ｈａｉｋｕ, keep the payload",
            "haiku",
            "keep the payload",
            "canonical",
            aliases=("haiku",),
        )

    def test_configured_phrase_matches_after_canonical_stage(self) -> None:
        self.assert_route(
            "Op. 47, explain this chord",
            "opus47",
            "explain this chord",
            "configured",
            config_data=b"[opus47]\nmatch_phrases = ['op 47']\n",
        )

    def test_unique_fuzzy_variants_match_with_similarity_diagnostics(self) -> None:
        for spoken, alias in (("Tara", "terra"), ("Kwen", "qwen")):
            with self.subTest(spoken=spoken):
                result = route_transcript(
                    f"{spoken}, explain perfect chords",
                    ALIASES,
                    parse_config(None, ALIASES),
                )
                self.assertEqual(result.alias, alias)
                self.assertEqual(result.question, "explain perfect chords")
                self.assertEqual(result.reason, "fuzzy")
                self.assertGreaterEqual(result.similarity or 0, 65)

    def test_fuzzy_near_neighbor_inside_margin_rejects(self) -> None:
        aliases = ("qwen", "when")
        result = route_transcript("Kwen, explain chords", aliases, parse_config(None, aliases))

        self.assertFalse(result.accepted)
        self.assertEqual(result.reason, "ambiguous")

    def test_weak_short_length_and_digit_mismatch_candidates_reject(self) -> None:
        cases = (
            ("zzzz explain", ("terra",)),
            ("fred explain", ("fre",)),
            ("verylongalias explain", ("terra",)),
            ("opus48 explain", ("opus47",)),
        )

        for transcript, aliases in cases:
            with self.subTest(transcript=transcript):
                result = route_transcript(transcript, aliases, parse_config(None, aliases))
                self.assertFalse(result.accepted)

    def test_default_configured_and_omitted_wake_words(self) -> None:
        for transcript in (
            "Hey Terra, answer this",
            "Computer Terra, answer this",
            "Terra, answer this",
        ):
            with self.subTest(transcript=transcript):
                self.assert_route(
                    transcript,
                    "terra",
                    "answer this",
                    "canonical",
                    config_data=b'wake_words = ["hey", "computer"]\n',
                )

    def test_literal_wake_word_alias_falls_back_to_original_view(self) -> None:
        self.assert_route(
            "Hey, explain status",
            "hey",
            "explain status",
            "canonical",
            aliases=("hey",),
        )

    def test_reserved_wake_words_alias_still_routes_with_defaults(self) -> None:
        self.assert_route(
            "wake words, explain status",
            "wake_words",
            "explain status",
            "canonical",
            aliases=("wake_words",),
        )

    def test_empty_alias_only_wake_only_and_punctuation_question_reject(self) -> None:
        for transcript in ("", "terra", "hey", "terra, ..."):
            with self.subTest(transcript=transcript):
                result = route_transcript(transcript, ALIASES, parse_config(None, ALIASES))
                self.assertFalse(result.accepted)
                self.assertIsNone(result.alias)
                self.assertIsNone(result.question)


if __name__ == "__main__":
    unittest.main()
