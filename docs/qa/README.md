# QA Test Scenarios

Manual test scenarios for verifying reader functionality.

## Structure

```
docs/qa/
├── README.md           # This file
└── scenarios/          # Individual test scenarios
    └── *.md
```

## Running Tests

When asked to run a QA scenario:
1. Follow steps exactly as written
2. Verify each expected result
3. Document any deviations in "Actual Results"

## Scenario Format

Each scenario includes:
- **Preconditions**: Setup required before testing
- **Steps**: Actions to perform
- **Expected Results**: What should happen
- **Actual Issues**: Known bugs (updated after testing)

## Scenarios

| ID | Name | Area |
|----|------|------|
| QA-001 | [Reading Progress & Auto-Save](scenarios/QA-001-reading-progress.md) | Reader, Library |
| QA-002 | [Library Multilang Navigation](scenarios/QA-002-library-multilang-navigation.md) | Library, i18n |
| QA-003 | [SSG Rebuild Admin](scenarios/QA-003-ssg-rebuild.md) | Admin, SSG |
| QA-004 | [Bookmarks & Autosave](scenarios/QA-004-bookmarks-autosave.md) | Reader, Bookmarks |
