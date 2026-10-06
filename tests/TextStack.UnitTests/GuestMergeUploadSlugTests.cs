using Application.Auth;

namespace TextStack.UnitTests;

/// <summary>
/// Guest merge used to DROP a guest upload whose slug the account already had — and with it the
/// guest's progress, while its highlights were orphaned (reader audit M1). It now renames it.
/// </summary>
public class GuestMergeUploadSlugTests
{
    private static readonly Guid BookId = Guid.Parse("abcdef12-3456-7890-abcd-ef1234567890");

    [Fact]
    public void MergedUploadSlug_NoConflict_KeepsSlug()
    {
        var taken = new HashSet<string> { "dune" };
        Assert.Equal("dune", AuthService.MergedUploadSlug("dune", BookId, new HashSet<string> { "other" }, taken));
    }

    [Fact]
    public void MergedUploadSlug_AccountHasSlug_SuffixesShortId()
    {
        var account = new HashSet<string> { "dune" };
        var taken = new HashSet<string>(account);

        Assert.Equal("dune-abcdef12", AuthService.MergedUploadSlug("dune", BookId, account, taken));
        Assert.Contains("dune-abcdef12", taken);
    }

    [Fact]
    public void MergedUploadSlug_ShortSuffixTaken_UsesFullId()
    {
        var account = new HashSet<string> { "dune", "dune-abcdef12" };

        Assert.Equal("dune-abcdef1234567890abcdef1234567890",
            AuthService.MergedUploadSlug("dune", BookId, account, new HashSet<string>(account)));
    }

    [Fact]
    public void MergedUploadSlug_MaxLengthSlug_StaysWithinColumn()
    {
        var slug = new string('a', 500);
        var account = new HashSet<string> { slug };

        var result = AuthService.MergedUploadSlug(slug, BookId, account, new HashSet<string>(account));

        Assert.Equal(500, result.Length);
        Assert.EndsWith("-abcdef12", result);
    }
}
