---
description: Universal code quality rules — applies to all files in all stacks
---

## SEARCH FIRST Protocol
Before creating any class, function, or module, search the codebase for similar patterns. If 80%+ overlap with the same concern exists, extend the existing code — do not create a new one. If less than 80% overlap or a genuinely different concern, create new. If uncertain whether overlap is sufficient, ask before proceeding.

## Code Structure Limits
Max 20 lines per function body (40 lines for config/builder methods). Max 4 parameters per function or method signature. If either limit is exceeded, split into smaller units before proceeding.

## SOLID Principles
- **Single Responsibility**: Each class or module has one reason to change.
- **Open/Closed**: Extend behavior through composition or inheritance, not modification.
- **Liskov Substitution**: Subtypes must be substitutable for their base types without altering correctness.
- **Interface Segregation**: Prefer narrow, focused interfaces over wide, general-purpose ones.
- **Dependency Inversion**: Depend on abstractions, not concretions. Inject dependencies.

## DRY / KISS / YAGNI
- **DRY**: Every piece of knowledge has a single, authoritative representation. Duplication is a bug.
- **KISS**: The simplest solution that works is the correct one. Add complexity only when required.
- **YAGNI**: Do not implement functionality until it is actually needed. Speculative generality adds debt.

## Design Patterns
Use Strategy for interchangeable algorithms, Factory for object creation, Adapter for interface translation, and Builder for complex object construction. Avoid Singleton (hides dependencies, obstructs testing) and Service Locator (obscures dependencies, inverts control in the wrong direction).

## Error Handling
Chain errors with cause context using `new Error("context message", { cause: originalError })`. Use discriminated Result types (`{ ok: true, value }` / `{ ok: false, error }`) for recoverable error paths. Never swallow exceptions silently — log or rethrow with context at every catch boundary.

## No Commented-Out Code
Delete dead code instead of commenting it out. Git history preserves all previous states — a comment is not a backup. Leaving commented code in the codebase is noise that misleads future readers about intent.
