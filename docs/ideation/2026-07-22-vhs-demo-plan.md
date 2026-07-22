# VHS demo plan

## Goal

Turn the README's core promise into a short, credible terminal proof: one familiar infrastructure error goes in, one useful plain-English sentence comes out through a local-model alias.

## Storyboard

1. Open on the completed answer so the static preview communicates value before playback.
2. Loop to a clean terminal and type one real command at a readable pace.
3. Run `llm-now local` against a saved, warmed-up model.
4. Hold the answer long enough to read before looping.

The command is deliberately narrow:

```bash
llm-now local --input "In one sentence, explain: ECONNREFUSED 127.0.0.1:5432"
```

It demonstrates the compact alias syntax, one-shot input, and useful stdout without implying that `llm-now` can inspect the working directory.

## Recording setup

Before rendering:

1. Install `llm-now` and [VHS](https://github.com/charmbracelet/vhs).
2. Use bare `llm-now` to save a fast provider/model as the global alias `local`.
3. Run the demo command once to warm the model and confirm that it answers in one short sentence.
4. From the repository root, run `vhs docs/llm-now-demo.tape`.

The tape writes `docs/llm-now-demo.gif`. It performs a real generation call and contains no simulated model response, provider credential, or provider-specific model ID.

## Visual direction

- 1200 × 500 canvas for legibility at README width
- Menlo at 28 px for a native terminal feel
- Catppuccin Mocha with a restrained dark margin
- 30 fps, hidden cursor blink, and an answer-first loop offset
- One command and one response; no setup tour or scrolling

## Acceptance criteria

- `vhs validate docs/llm-now-demo.tape` succeeds.
- The command and full response remain visible without scrolling or clipping.
- The response is one sentence and the final frame is held for four seconds.
- No secret, local filesystem path, provider-specific model ID, or fabricated output appears.
- The GIF remains small enough for a fast README load; optimize it before committing if it exceeds 5 MB.

## Follow-on assets

Keep the hero GIF focused. If more proof is useful later, record separate clips for piped stdin and interactive provider discovery instead of extending this loop.
