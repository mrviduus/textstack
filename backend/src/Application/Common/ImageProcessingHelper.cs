using HtmlAgilityPack;

namespace Application.Common;

public static class ImageProcessingHelper
{
    public static string RewriteImageSrcs(string html, Dictionary<string, string> imageMap)
    {
        if (string.IsNullOrEmpty(html) || imageMap.Count == 0)
            return html;

        var doc = new HtmlDocument();
        doc.LoadHtml(html);

        var imgNodes = doc.DocumentNode.SelectNodes("//img[@src]");
        if (imgNodes == null)
            return html;

        foreach (var img in imgNodes)
        {
            var src = img.GetAttributeValue("src", "");
            if (string.IsNullOrEmpty(src))
                continue;

            var normalizedSrc = NormalizeImagePath(src);

            foreach (var (originalPath, newUrl) in imageMap)
            {
                var normalizedOriginal = NormalizeImagePath(originalPath);
                if (normalizedSrc.Equals(normalizedOriginal, StringComparison.OrdinalIgnoreCase) ||
                    normalizedSrc.EndsWith(normalizedOriginal, StringComparison.OrdinalIgnoreCase) ||
                    normalizedOriginal.EndsWith(normalizedSrc, StringComparison.OrdinalIgnoreCase))
                {
                    img.SetAttributeValue("src", newUrl);
                    break;
                }
            }
        }

        return doc.DocumentNode.InnerHtml;
    }

    public static string NormalizeImagePath(string path)
    {
        var result = path;
        while (result.StartsWith("../"))
            result = result[3..];
        while (result.StartsWith("./"))
            result = result[2..];
        result = result.TrimStart('/');
        return result;
    }

    public static string GetExtensionFromMimeType(string mimeType)
    {
        return mimeType switch
        {
            "image/png" => ".png",
            "image/gif" => ".gif",
            "image/webp" => ".webp",
            "image/svg+xml" => ".svg",
            _ => ".jpg"
        };
    }
}
