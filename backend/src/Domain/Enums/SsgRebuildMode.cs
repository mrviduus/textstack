namespace Domain.Enums;

public enum SsgRebuildMode
{
    Full = 0,
    // Incremental = 1 and Specific = 2 removed 2026-10-08 (ADR-023): ssg-worker always renders every
    // route, so Full is the only mode. Prod had only Full rows. The column stays; EF reads any stored
    // value as Full (AppDbContext.Ops.cs).
}
