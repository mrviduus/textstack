using HtmlAgilityPack;

namespace Application.SeoCrawl;

public record SeoData(
    string? Title,
    string? MetaDescription,
    string? H1,
    string? Canonical,
    string? MetaRobots
);

public static class HtmlSeoParser
{
    public static SeoData Parse(string html, string baseUrl)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var title = ExtractTitle(doc);
        var metaDescription = ExtractMetaDescription(doc);
        var h1 = ExtractH1(doc);
        var canonical = ExtractCanonical(doc);
        var metaRobots = ExtractMetaRobots(doc);

        return new SeoData(title, metaDescription, h1, canonical, metaRobots);
    }

    private static string? ExtractTitle(HtmlDocument doc)
    {
        var titleNode = doc.DocumentNode.SelectSingleNode("//title");
        return titleNode?.InnerText?.Trim();
    }

    private static string? ExtractMetaDescription(HtmlDocument doc)
    {
        var descNode = doc.DocumentNode.SelectSingleNode(
            "//meta[@name='description']") ??
            doc.DocumentNode.SelectSingleNode(
            "//meta[@name='Description']");
        return descNode?.GetAttributeValue("content", null)?.Trim();
    }

    private static string? ExtractH1(HtmlDocument doc)
    {
        var h1Node = doc.DocumentNode.SelectSingleNode("//h1");
        return h1Node?.InnerText?.Trim();
    }

    private static string? ExtractCanonical(HtmlDocument doc)
    {
        var canonicalNode = doc.DocumentNode.SelectSingleNode(
            "//link[@rel='canonical']");
        return canonicalNode?.GetAttributeValue("href", null)?.Trim();
    }

    private static string? ExtractMetaRobots(HtmlDocument doc)
    {
        var robotsNode = doc.DocumentNode.SelectSingleNode(
            "//meta[@name='robots']") ??
            doc.DocumentNode.SelectSingleNode(
            "//meta[@name='Robots']");
        return robotsNode?.GetAttributeValue("content", null)?.Trim();
    }
}
