from __future__ import annotations

import json
import unittest
import signal
import subprocess
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from llm_now_voice.cli import (
    ProcessCancelled,
    ProcessResult,
    ProcessTimedOut,
    SubprocessRunner,
    VoiceRouterError,
    compact_key,
    main,
    parse_config,
    parse_inventory,
    parse_voice_inventory,
    route_transcript,
    run_voice_router,
)


ALIASES = ("deepseek32", "fred", "haiku", "local", "opus47", "qwen", "terra")
PARITY_CORPUS = json.loads(
    (Path(__file__).parent / "fixtures" / "routing-parity.json").read_text(
        encoding="utf-8"
    )
)


class RoutingParityCorpusTests(unittest.TestCase):
    def test_normalization_corpus(self) -> None:
        for case in PARITY_CORPUS["normalization"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(compact_key(case["input"]), case["compact"])

    def test_raw_score_corpus(self) -> None:
        from rapidfuzz import fuzz

        for case in PARITY_CORPUS["scores"]:
            with self.subTest(case=case["id"]):
                left = compact_key(case["left"]) if case.get("normalize") else case["left"]
                right = compact_key(case["right"]) if case.get("normalize") else case["right"]
                self.assertAlmostEqual(
                    fuzz.ratio(left, right, processor=None), case["expected"], places=10
                )

    def test_route_corpus_with_unicode_scalar_offsets(self) -> None:
        for case in PARITY_CORPUS["routes"]:
            with self.subTest(case=case["id"]):
                aliases = tuple(case["aliases"])
                config_text = case.get("config_toml")
                config = parse_config(
                    config_text.encode("utf-8") if config_text is not None else None,
                    aliases,
                )
                result = route_transcript(case["transcript"], aliases, config)
                expected = case["expected"]

                self.assertEqual(result.alias, expected["alias"])
                self.assertEqual(result.question, expected["question"])
                self.assertEqual(result.reason, expected["reason"])
                if expected["similarity"] is None:
                    self.assertIsNone(result.similarity)
                else:
                    self.assertAlmostEqual(
                        result.similarity or 0, expected["similarity"], places=10
                    )
                if expected["runner_up_similarity"] is None:
                    self.assertIsNone(result.runner_up_similarity)
                else:
                    self.assertAlmostEqual(
                        result.runner_up_similarity or 0,
                        expected["runner_up_similarity"],
                        places=10,
                    )

                question_offset = (
                    len(case["transcript"]) - len(result.question)
                    if result.question is not None
                    else None
                )
                self.assertEqual(question_offset, expected["question_offset"])


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
pitch = 50

[opus47]
match_phrases = ["op 47"]
pitch = 50.5

[haiku]
pitch = 1

[fred]
pitch = 127
''',
            ALIASES,
        )

        self.assertEqual(config.wake_words, ("hey", "computer"))
        self.assertEqual(config.profiles["terra"].match_phrases, ("tara",))
        self.assertEqual(config.profiles["terra"].voice, "Samantha")
        self.assertEqual(config.profiles["terra"].rate, 205)
        self.assertEqual(config.profiles["terra"].pitch, 50)
        self.assertEqual(config.profiles["opus47"].pitch, 50.5)
        self.assertEqual(config.profiles["haiku"].pitch, 1)
        self.assertEqual(config.profiles["fred"].pitch, 127)

    def test_rejects_invalid_pitch_types_and_values(self) -> None:
        invalid = (
            b"[terra]\npitch = 0\n",
            b"[terra]\npitch = -1\n",
            b"[terra]\npitch = 128\n",
            b"[terra]\npitch = true\n",
            b"[terra]\npitch = '50'\n",
            b"[terra]\npitch = nan\n",
            b"[terra]\npitch = inf\n",
            b"[terra]\npitch = -inf\n",
            b"[terra]\npitch = " + (b"9" * 400) + b"\n",
        )

        for data in invalid:
            with self.subTest(data=data), self.assertRaisesRegex(
                VoiceRouterError, "terra.pitch"
            ):
                parse_config(data, ALIASES)

    def test_rejects_invalid_pitch_in_stale_profile_and_raw_speech_fields(self) -> None:
        with self.assertRaisesRegex(VoiceRouterError, "retired.pitch"):
            parse_config(b"[retired]\npitch = 200\n", ALIASES)

        with self.assertRaisesRegex(VoiceRouterError, "unknown profile field"):
            parse_config(b"[terra]\nspeech_prefix = '[[pbas 50]]'\n", ALIASES)

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


class FakeRunner:
    def __init__(self, results: list[ProcessResult | Exception]) -> None:
        self.results = results
        self.calls: list[tuple[tuple[str, ...], bytes | None, float]] = []

    def run(
        self, args: tuple[str, ...], input_data: bytes | None, timeout: float
    ) -> ProcessResult:
        self.calls.append((args, input_data, timeout))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def completed(
    stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0
) -> ProcessResult:
    return ProcessResult(returncode=returncode, stdout=stdout, stderr=stderr)


INVENTORY = (
    b"haiku \xe2\x86\x92 Anthropic \xc2\xb7 claude-haiku\n"
    b"terra \xe2\x86\x92 Codex CLI \xc2\xb7 gpt-5.6-terra\n"
)


class VoiceInventoryTests(unittest.TestCase):
    def test_parses_multiword_voice_names_case_insensitively(self) -> None:
        voices = parse_voice_inventory(
            "Samantha            en_US    # Hello\n"
            "Eddy (English (US)) en_US    # Hello\n"
        )

        self.assertEqual(voices["samantha"], "Samantha")
        self.assertEqual(voices["eddy (english (us))"], "Eddy (English (US))")

    def test_rejects_malformed_or_duplicate_voice_rows(self) -> None:
        for text in ("not a voice row\n", "Samantha en_US # one\nSAMANTHA en_US # two\n"):
            with self.subTest(text=text), self.assertRaises(VoiceRouterError):
                parse_voice_inventory(text)


class OrchestrationTests(unittest.TestCase):
    def run_router(
        self,
        transcript: bytes,
        results: list[ProcessResult | Exception],
        *,
        config_data: bytes | None = None,
    ) -> tuple[int, FakeRunner, str]:
        runner = FakeRunner(results)
        stderr = StringIO()
        exit_code = run_voice_router(
            transcript,
            runner=runner,
            config_data=config_data,
            stderr=stderr,
        )
        self.assertEqual(runner.results, [])
        return exit_code, runner, stderr.getvalue()

    def test_success_calls_inventory_generation_copy_and_speech_once_in_order(self) -> None:
        answer = b"Tender smoke rises\nBrisket rests beneath the stars\nSummer on the plate\n"
        code, runner, diagnostics = self.run_router(
            b"Hey haiku, write about brisket",
            [completed(INVENTORY), completed(answer), completed(), completed()],
        )

        self.assertEqual(code, 0)
        self.assertEqual(diagnostics, "")
        self.assertEqual(
            [call[0] for call in runner.calls],
            [
                ("llm-now", "--aliases"),
                ("llm-now", "--alias", "haiku"),
                ("/usr/bin/pbcopy",),
                ("/usr/bin/say",),
            ],
        )
        prompt = runner.calls[1][1]
        self.assertIsNotNone(prompt)
        self.assertTrue(prompt.endswith(b"\n\nwrite about brisket"))
        self.assertEqual(runner.calls[2][1], answer)
        self.assertEqual(runner.calls[3][1], answer)
        self.assertEqual([call[2] for call in runner.calls], [5, 50, 5, 120])

    def test_selected_voice_and_rate_are_validated_before_generation(self) -> None:
        config = b"[terra]\nvoice = 'samantha'\nrate = 205\npitch = 50\n"
        voices = b"Samantha en_US    # Hello\nAlex en_US    # Hello\n"
        answer = b"Answer"
        code, runner, _ = self.run_router(
            b"Tara, answer this",
            [completed(INVENTORY), completed(voices), completed(answer), completed(), completed()],
            config_data=config,
        )

        self.assertEqual(code, 0)
        self.assertEqual(
            [call[0] for call in runner.calls],
            [
                ("llm-now", "--aliases"),
                ("/usr/bin/say", "-v", "?"),
                ("llm-now", "--alias", "terra"),
                ("/usr/bin/pbcopy",),
                ("/usr/bin/say", "-v", "Samantha", "-r", "205"),
            ],
        )
        self.assertEqual(runner.calls[3][1], answer)
        self.assertEqual(runner.calls[4][1], b"[[pbas 50]]" + answer)

    def test_each_alias_uses_its_own_fractional_or_integer_pitch(self) -> None:
        config = b"[haiku]\npitch = 50.5\n[terra]\npitch = 70\n"

        for transcript, prefix in (
            (b"haiku, answer this", b"[[pbas 50.5]]"),
            (b"terra, answer this", b"[[pbas 70]]"),
        ):
            with self.subTest(transcript=transcript):
                answer = b"Answer"
                code, runner, _ = self.run_router(
                    transcript,
                    [completed(INVENTORY), completed(answer), completed(), completed()],
                    config_data=config,
                )

                self.assertEqual(code, 0)
                self.assertEqual(runner.calls[2][1], answer)
                self.assertEqual(runner.calls[3][1], prefix + answer)

    def test_unavailable_voice_fails_before_generation(self) -> None:
        code, runner, diagnostics = self.run_router(
            b"terra, answer this",
            [completed(INVENTORY), completed(b"Alex en_US    # Hello\n"), completed()],
            config_data=b"[terra]\nvoice = 'Samantha'\n",
        )

        self.assertEqual(code, 1)
        self.assertIn("Samantha", diagnostics)
        self.assertEqual(runner.calls[-1][0], ("/usr/bin/say",))
        self.assertNotIn(("llm-now", "--alias", "terra"), [call[0] for call in runner.calls])

    def test_rejected_input_speaks_retry_without_generation_or_clipboard(self) -> None:
        code, runner, _ = self.run_router(
            b"unknown, answer this",
            [completed(INVENTORY), completed()],
            config_data=b"[haiku]\npitch = 50\n",
        )

        self.assertEqual(code, 0)
        self.assertEqual([call[0] for call in runner.calls], [("llm-now", "--aliases"), ("/usr/bin/say",)])
        self.assertIn(b"try again", runner.calls[-1][1] or b"")
        self.assertNotIn(b"[[pbas", runner.calls[-1][1] or b"")

    def test_malformed_inventory_speaks_retry_and_preserves_diagnostics_locally(self) -> None:
        code, runner, diagnostics = self.run_router(
            b"haiku, answer this",
            [completed(b"malformed\n", b"inventory warning"), completed()],
        )

        self.assertEqual(code, 0)
        self.assertIn("invalid alias inventory", diagnostics)
        self.assertNotIn(b"inventory warning", runner.calls[-1][1] or b"")

    def test_provider_failures_never_reach_clipboard_or_spoken_payload(self) -> None:
        failures: list[ProcessResult | Exception] = [
            completed(stderr=b"secret provider detail", returncode=2),
            ProcessTimedOut(("llm-now", "--alias", "haiku"), 50),
            completed(stdout=b"   \n"),
            completed(stdout=b"bad \xff output"),
            completed(stdout=b"unsafe\x1b[31m text"),
            completed(stdout=b"unsafe [[slnc 100]] text"),
            completed(stdout=b"unsafe\x00 text"),
        ]

        for failure in failures:
            with self.subTest(failure=failure):
                code, runner, diagnostics = self.run_router(
                    b"haiku, answer this",
                    [completed(INVENTORY), failure, completed()],
                    config_data=b"[haiku]\npitch = 50\n",
                )
                self.assertEqual(code, 0)
                self.assertNotIn(("/usr/bin/pbcopy",), [call[0] for call in runner.calls])
                self.assertIn(b"request failed", (runner.calls[-1][1] or b"").lower())
                self.assertNotIn(b"[[pbas", runner.calls[-1][1] or b"")
                self.assertNotIn(b"secret provider detail", runner.calls[-1][1] or b"")
                self.assertTrue(diagnostics)

    def test_clipboard_failure_prevents_answer_speech(self) -> None:
        answer = b"answer"
        code, runner, _ = self.run_router(
            b"haiku, answer this",
            [completed(INVENTORY), completed(answer), completed(returncode=1), completed()],
            config_data=b"[haiku]\npitch = 50\n",
        )

        self.assertEqual(code, 1)
        self.assertEqual(runner.calls[-1][0], ("/usr/bin/say",))
        self.assertNotEqual(runner.calls[-1][1], answer)
        self.assertNotIn(b"[[pbas", runner.calls[-1][1] or b"")

    def test_invalid_pitch_fails_before_generation_with_unmodulated_notice(self) -> None:
        code, runner, diagnostics = self.run_router(
            b"haiku, answer this",
            [completed(INVENTORY), completed()],
            config_data=b"[haiku]\npitch = 128\n",
        )

        self.assertEqual(code, 1)
        self.assertIn("haiku.pitch", diagnostics)
        self.assertEqual(
            [call[0] for call in runner.calls],
            [("llm-now", "--aliases"), ("/usr/bin/say",)],
        )
        self.assertNotIn(b"[[pbas", runner.calls[-1][1] or b"")

    def test_speech_failure_after_copy_leaves_answer_without_new_notice(self) -> None:
        answer = b"answer"
        code, runner, _ = self.run_router(
            b"haiku, answer this",
            [completed(INVENTORY), completed(answer), completed(), completed(returncode=1)],
            config_data=b"[haiku]\npitch = 50\n",
        )

        self.assertEqual(code, 1)
        self.assertEqual(len(runner.calls), 4)
        self.assertEqual(runner.calls[2][1], answer)
        self.assertEqual(runner.calls[3][1], b"[[pbas 50]]" + answer)

    def test_cancellation_stops_downstream_work_at_each_side_effect(self) -> None:
        for prior, cancellation_index in (
            ([completed(INVENTORY), completed(b"answer")], 2),
            ([completed(INVENTORY), completed(b"answer"), completed()], 3),
        ):
            with self.subTest(cancellation_index=cancellation_index):
                runner = FakeRunner([*prior, ProcessCancelled()])
                code = run_voice_router(
                    b"haiku, answer this", runner=runner, config_data=None, stderr=StringIO()
                )
                self.assertEqual(code, 130)
                self.assertEqual(len(runner.calls), cancellation_index + 1)

    def test_missing_command_is_a_setup_failure(self) -> None:
        runner = FakeRunner([FileNotFoundError("llm-now") , completed()])
        stderr = StringIO()

        code = run_voice_router(b"haiku, answer this", runner=runner, stderr=stderr)

        self.assertEqual(code, 1)
        self.assertIn("llm-now", stderr.getvalue())
        self.assertEqual(runner.calls[-1][0], ("/usr/bin/say",))

    def test_preflight_missing_side_effect_command_starts_no_llm_now_process(self) -> None:
        for missing in ("/usr/bin/pbcopy", "/usr/bin/say"):
            with self.subTest(missing=missing):
                runner = FakeRunner([] if missing.endswith("say") else [completed()])
                stderr = StringIO()
                code = run_voice_router(
                    b"haiku, answer this",
                    runner=runner,
                    stderr=stderr,
                    command_available=lambda command: command != missing,
                )
                self.assertEqual(code, 1)
                self.assertNotIn(("llm-now", "--aliases"), [call[0] for call in runner.calls])
                self.assertIn(missing, stderr.getvalue())


class MainTests(unittest.TestCase):
    def test_non_macos_fails_before_starting_the_router(self) -> None:
        stderr = StringIO()

        with (
            patch("llm_now_voice.cli.sys.platform", "linux"),
            patch("llm_now_voice.cli.sys.stderr", stderr),
            patch("llm_now_voice.cli.SubprocessRunner") as runner,
        ):
            code = main()

        self.assertEqual(code, 1)
        self.assertEqual(
            stderr.getvalue(), "llm-now-voice currently supports macOS only.\n"
        )
        runner.assert_not_called()


class FakeProcess:
    def __init__(self, communicate_results: list[object]) -> None:
        self.pid = 4321
        self.returncode: int | None = None
        self.communicate_results = communicate_results
        self.inputs: list[bytes | None] = []

    def communicate(self, input: bytes | None = None, timeout: float | None = None):
        self.inputs.append(input)
        result = self.communicate_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def poll(self) -> int | None:
        return self.returncode


class SubprocessRunnerTests(unittest.TestCase):
    def test_signal_handler_can_reenter_active_process_lock(self) -> None:
        runner = SubprocessRunner()

        with runner._lock:
            acquired = runner._lock.acquire(blocking=False)
            self.assertTrue(acquired)
            runner._lock.release()

    def test_timeout_terminates_and_reaps_the_process_group(self) -> None:
        process = FakeProcess([
            subprocess.TimeoutExpired(("slow",), 5),
            (b"", b""),
        ])
        spawned: list[dict[str, object]] = []
        signals: list[tuple[int, int]] = []

        def popen(args: tuple[str, ...], **kwargs: object) -> FakeProcess:
            spawned.append({"args": args, **kwargs})
            return process

        def killpg(pid: int, sent_signal: int) -> None:
            signals.append((pid, sent_signal))
            process.returncode = -sent_signal

        runner = SubprocessRunner(popen=popen, killpg=killpg)

        with self.assertRaises(ProcessTimedOut):
            runner.run(("slow",), b"input", 5)

        self.assertTrue(spawned[0]["start_new_session"])
        self.assertFalse(spawned[0]["shell"])
        self.assertEqual(signals, [(4321, signal.SIGTERM)])
        self.assertEqual(process.communicate_results, [])

    def test_timeout_force_kills_when_termination_does_not_finish(self) -> None:
        process = FakeProcess([
            subprocess.TimeoutExpired(("slow",), 5),
            subprocess.TimeoutExpired(("slow",), 1),
            (b"", b""),
        ])
        signals: list[int] = []

        def killpg(_pid: int, sent_signal: int) -> None:
            signals.append(sent_signal)
            if sent_signal == signal.SIGKILL:
                process.returncode = -sent_signal

        runner = SubprocessRunner(popen=lambda _args, **_kwargs: process, killpg=killpg)

        with self.assertRaises(ProcessTimedOut):
            runner.run(("slow",), None, 5)

        self.assertEqual(signals, [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(process.communicate_results, [])

    def test_precancelled_runner_never_spawns(self) -> None:
        spawned = False

        def popen(_args: tuple[str, ...], **_kwargs: object) -> FakeProcess:
            nonlocal spawned
            spawned = True
            return FakeProcess([])

        runner = SubprocessRunner(popen=popen)
        runner.cancel()

        with self.assertRaises(ProcessCancelled):
            runner.run(("never",), None, 5)
        self.assertFalse(spawned)

    def test_active_cancellation_stops_and_reaps_the_process_group(self) -> None:
        signals: list[int] = []
        runner: SubprocessRunner

        class CancellingProcess(FakeProcess):
            def communicate(self, input: bytes | None = None, timeout: float | None = None):
                self.inputs.append(input)
                runner.cancel()
                self.returncode = -signal.SIGKILL
                return b"", b""

        process = CancellingProcess([])

        def killpg(_pid: int, sent_signal: int) -> None:
            signals.append(sent_signal)

        runner = SubprocessRunner(popen=lambda _args, **_kwargs: process, killpg=killpg)

        with self.assertRaises(ProcessCancelled):
            runner.run(("slow",), None, 50)

        self.assertEqual(signals, [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(process.inputs, [None])


if __name__ == "__main__":
    unittest.main()
