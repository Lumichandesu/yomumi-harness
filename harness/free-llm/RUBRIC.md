# Easy vs hard (free-tier offload rubric)

SEND to free tier (all must be true): public or non-sensitive text, no secrets, no user data, result is checked or low-stakes, under ~6k words, one clear instruction.
Examples: summarize news/RSS items, translate a short public text, classify headlines, extract titles/dates from public pages, spelling fix of public copy.

KEEP ON PAID/LOCAL MODEL: design, UI judgment, auth/sessions, money/ledger/payments, deletion/privacy, security findings, code that will ship, anything with credentials, e-mail addresses, personal data, or private source code.
Pure file search stays with Haiku/grep.

Rules: free output is a draft; the calling agent verifies before acting. If the tool exits 3 (refused) or 4 (no provider), use the normal routing (Haiku search, Sonnet short, Opus long). Never put keys in files; set them as Windows user environment variables.
