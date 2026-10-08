namespace Domain.Enums;

public enum SsgRebuildMode
{
    Full = 0,
    Incremental = 1
    // Specific = 2 removed 2026-10-08: no per-edit rebuilds (nightly Full only); prod never had a row.
}
