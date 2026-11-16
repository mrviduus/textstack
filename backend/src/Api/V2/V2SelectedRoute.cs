namespace Api.V2;

/// <summary>Reviewed to use the selected identity database or V2 repositories, rather than legacy user data.</summary>
public sealed class V2SelectedRoute
{
    public static readonly V2SelectedRoute Instance = new();
    private V2SelectedRoute() { }
}
