# Architecture Decision Records

Every important technical or product decision must be documented here — not left to disappear inside chat history or a commit message nobody re-reads.

Each ADR contains:

- **Date**
- **Status** — Accepted / Superseded / Deprecated
- **Context** — what was true about the project when this decision was made
- **Problem** — what specifically needed deciding
- **Decision** — what was actually decided
- **Alternatives** — what else was considered, and why it wasn't chosen
- **Consequences** — what this decision made easier, harder, or ruled out
- **Future work** — what this decision deliberately leaves open or unresolved

## Rules

- **Never modify a previous ADR except for a factual correction** (e.g. fixing a wrong date, a broken link, a typo). If a decision is later changed or reversed, write a **new** ADR that explains the change and mark the old one's Status as `Superseded` (with a link to the one that supersedes it). The old ADR's own content stays intact — it's still an accurate record of what was decided and why, at the time.
- **Numbering is sequential and permanent**: `ADR-0001`, `ADR-0002`, `ADR-0003`, ... Never reuse a number, even if an ADR is superseded or turns out to be a mistake.
- ADRs record **architectural and product decisions**, not implementation details. If it wouldn't matter to someone deciding whether to reverse the decision two years from now, it probably belongs in code comments or `README.md`, not here.

## Template

```markdown
# ADR-XXXX: <short title>

Date: YYYY-MM-DD

Status: Accepted / Superseded / Deprecated

## Context

## Problem

## Decision

## Alternatives

## Consequences

## Future work
```

## Index

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](./ADR-0001-project-history.md) | Project history — architectural evolution to date | Accepted |
