# Code-mode MCP gateway: two tools instead of hundreds

The code-mode gateway is a local MCP server (Model Context Protocol) in the Yomumi Harness that exposes only two tools to a model, `search` and `execute`, instead of loading every tool schema from every connected server into the context window. The model searches for the tools and notes it needs, loads their schemas on demand, and writes a short script that calls them inside a capability-denied sandbox; the host returns compact, cited facts. It follows the "code mode" pattern described publicly by Cloudflare and Anthropic, and it is local-first, loopback-only and read-only by default.

[Back to the system overview](README.md)

## Contents

- [The problem it addresses](#the-problem-it-addresses)
- [The two public tools](#the-two-public-tools)
- [Sandbox: a separate process is not a sandbox](#sandbox-a-separate-process-is-not-a-sandbox)
- [Trust boundaries](#trust-boundaries)
- [Response envelope: token savings must not hide gaps](#response-envelope-token-savings-must-not-hide-gaps)
- [Transports](#transports)
- [What we measured in practice](#what-we-measured-in-practice)
- [What is not documented here](#what-is-not-documented-here)

## The problem it addresses

Every MCP server an agent connects to adds its tool definitions to the prompt. With many servers, those definitions cost tokens on every turn, and intermediate results (a long list, a large document) flow through the model even when it only needs one field. [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/) converts MCP tools into a TypeScript API and asks the model to write code against it; [Anthropic's write-up on code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) describes progressive disclosure of tools and filtering data in the execution environment before it reaches the model. The gateway applies both ideas behind one local server.

## The two public tools

| Tool | What it does |
| --- | --- |
| `search` | Progressive discovery across indexed tools and an allowlist of local notes and repository docs. Full-text search with word and trigram indexes (so English, Thai, Japanese and exact ids all match), two-stage note browsing (headings first, then excerpts), schemas loaded only for the tools you name, and paging through large results by an opaque reference. |
| `execute` | Runs a short async JavaScript snippet in the sandbox with a host-brokered `tools.call()` and `tools.batch()`, or runs a reviewed, predefined workflow by name. Scripts batch independent calls, chain dependent ones, and project or deduplicate results before returning. |

The model never sees the full catalog. It asks for what it needs, when it needs it.

## Sandbox: a separate process is not a sandbox

Model-written code runs in a [Deno](https://docs.deno.com/runtime/fundamentals/security/) isolate started with every permission denied (read, write, network, environment, subprocess, FFI, system, dynamic import), a V8 heap cap, a wall-clock kill and locked-down globals. The only way out is the host broker, which checks the caller's scope before forwarding a tool call.

Before trusting arbitrary code, the gateway actively tries to escape: it probes a canary file, a canary environment variable, a loopback network canary, a subprocess and a dynamic import from inside the isolate. If any probe succeeds, the gateway **fails closed** to predefined-workflows-only mode and refuses arbitrary scripts. This check exists because "it runs in another process" was not, on its own, isolation.

## Trust boundaries

~~~text
[Agent client: Claude Code, Codex, Antigravity, Cursor, local model]
        |  MCP over loopback HTTP, stdio, or a tool-calling adapter
        v
+--------------------------------------------------------------+
| Host broker and policy                                        |
|  - loopback-only host/origin check                            |
|  - bearer auth and per-caller scopes                          |
|  - rate limiting                                              |
|  - task policies stored apart from compactable summaries      |
|  - mandatory output redaction (secrets, e-mail addresses)     |
|  - access-aware read cache and scoped, expiring artifacts     |
+------------------------+-------------------------------------+
                         |                     |
                         v                     v
          +--------------------------+   +---------------------------+
          | Deno isolate, all denied |   | Read-only connectors      |
          | heap cap, timeout kill   |   | SQLite index (FTS5)       |
          +--------------------------+   | write and payment guards  |
                                         +---------------------------+
~~~

Invariants we keep:

- **Compaction cannot relax rules.** A resumable task's policy is stored in a separate table and copied verbatim into any compacted hand-off brief; only the summary part is shortened.
- **Writes are opt-in per connector and per caller scope.** The default caller is read-only.
- **No paid escalation by default.** A local router does filtering, joins and classification in plain code; a route that would call a paid cloud model is blocked.
- **Private paths stay out.** Notes matching secret, credential, invite or archive patterns are excluded from the index, and outputs are redacted.

## Response envelope: token savings must not hide gaps

Every response carries a data-boundary marker (`UNTRUSTED_DATA_NOT_INSTRUCTIONS`) plus explicit fields for citations, conflicts, omitted items, freshness, truncation and failures. A compact answer that silently dropped a failed connector would look cleaner and be wrong; the envelope makes the gap visible. On the text wire, default values and zero metrics are trimmed, while the full typed object stays available as structured content.

## Transports

One core serves three transports:

- MCP Streamable HTTP bound to the loopback interface only;
- an MCP stdio bridge sharing the same SQLite database (write-ahead logging);
- a scoped adapter that translates OpenAI-style and Anthropic-style tool calls, for harnesses or models that do not speak MCP.

The MCP base protocol is JSON-RPC 2.0 ([specification](https://modelcontextprotocol.io/specification/2025-06-18)).

## What we measured in practice

Inside its own benchmarks the gateway keeps the public tool surface small and the answers compact; those numbers live with the private code, not in this repository, so we do not quote them here. The more useful lesson came from an A/B comparison during a tool audit on 2026-11-27: the gateway did not beat the agent's default built-in tools on answer quality, so it stays a task-specific and backup tool rather than the default path. That comparison was not published, so treat it as an internal observation, not a benchmark. Our reading: code mode is worth it when an agent would otherwise load many large tool catalogs or push big intermediate results through the model; for ordinary work in one repository, the built-in tools are simpler and were at least as good.

## What is not documented here

The gateway's individual connectors, workflows and configuration are private: several of them touch product systems. Only the pattern, the boundaries and the lessons are public.

Next: [Evidence-first verification](evidence-first-verification.md)
