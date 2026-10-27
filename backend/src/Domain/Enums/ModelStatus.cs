namespace Domain.Enums;

/// <summary>
/// Lifecycle of a <see cref="Domain.Entities.ModelRegistration"/> for a feature.
/// <c>Primary</c> serves real traffic; <c>Shadow</c> is a standby that serves nothing until
/// promoted (shadow calls were removed, #934); <c>Retired</c> is kept for audit only. Stored as a
/// string column (HasConversion&lt;string&gt;) so the values read in SQL.
/// </summary>
public enum ModelStatus
{
    Shadow = 0,
    Primary = 1,
    Retired = 2
}
