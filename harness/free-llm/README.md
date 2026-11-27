# freellm: free-tier LLM offload with a local refusal check

freellm is a single-file Bun script from the Yomumi Harness that sends easy, public text chores (summaries, short translations, labels, simple extraction, spelling fixes) to free LLM API tiers instead of paid models. Before anything leaves the machine it refuses text that looks like a secret, a credential, an e-mail address, or a security, sign-in, money or deletion topic (exit 3), then tries each configured provider within a conservative request budget and falls back to a local model. Its output is a draft for the calling agent to check.

Why and how: [Free-tier offload](../../docs/system/free-tier-offload.md). What may and may not be sent: [RUBRIC.md](RUBRIC.md).

> **Snapshot.** Public copy as of 2026-11-27. Free tiers, model names and limits change often; the provider list and budgets in `freellm.ts` are what we used on that date, not a recommendation. Read each provider's terms and data policy before you send anything.

## Usage

~~~sh
bun freellm.ts ask --task summarize --file notes.txt
bun freellm.ts ask --task translate --prompt "short public text" --provider local
bun freellm.ts status      # ready, cooling down or out of budget, per provider
bun freellm.ts rubric      # print RUBRIC.md
bun freellm.ts local-up    # start the local LM Studio server and model; local-down stops them
~~~

Tasks: `summarize`, `translate`, `classify`, `extract`, `rewrite`.

| Exit | Meaning |
| --- | --- |
| 0 | A provider answered; the reply is on stdout, the provider and model on stderr. |
| 2 | Bad input: empty, or over 24,000 characters. |
| 3 | Refused: the text looks sensitive. Use a paid or local model. |
| 4 | No free provider available. Use your normal routing. |

## Configuration

Each cloud provider is enabled by its API-key environment variable read from your user environment (see the `PROVIDERS` table in `freellm.ts` for the names; Cloudflare also needs `CLOUDFLARE_ACCOUNT_ID`), and its model can be overridden with a `FREELLM_<PROVIDER>_MODEL` variable. Never put keys in a file.

> **Check which keys are already set.** The key names are the generic ones (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` and so on) that other tools also read. If one is already in your environment, possibly for a paid, billing-enabled account, freellm will use it. Rename the `key` fields in `PROVIDERS` to tool-specific names if you do not want that.

`FREELLM_LOCAL_URL` and `FREELLM_LOCAL_MODEL` set the local OpenAI-compatible server. The default URL uses port 14320, which is our setup; LM Studio's own default is 1234, so set `FREELLM_LOCAL_URL` to match yours. `--provider local` skips the refusal check only when that URL is a loopback address (`127.0.0.1`, `localhost`, `[::1]`); any other host is refused. `local-up` and `local-down` are manual and expect the Windows LM Studio CLI at `%USERPROFILE%\.lmstudio\bin\lms.exe`. Usage counts (no prompts, no replies) are kept in `%LOCALAPPDATA%/free-llm/usage.json` or `$HOME/free-llm/usage.json`.

## Limits

- The refusal check is a keyword and pattern backstop, not a classifier. Apply the rubric yourself first.
- Free models make mistakes and invent facts. Verify before acting on the output.
- Treat input text as data: the system prompt says so, and the output is only a draft, but no prompt fully stops injection.
