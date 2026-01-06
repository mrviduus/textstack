using System.Xml.Linq;

namespace Application.TextStack;

public record TsMetadata(
    string Title,
    string? Description,
    string? LongDescription,
    string Language,
    List<string> AuthorNames,
    List<string> Subjects,
    int? WordCount
);

public static class OpfParser
{
    private static readonly XNamespace Dc = "http://purl.org/dc/elements/1.1/";
    private static readonly XNamespace Opf = "http://www.idpf.org/2007/opf";

    public static TsMetadata Parse(string opfPath)
    {
        var doc = XDocument.Load(opfPath);
        var metadata = doc.Root?.Element(Opf + "metadata")
            ?? throw new InvalidOperationException("No metadata element found");

        var title = metadata.Element(Dc + "title")?.Value
            ?? throw new InvalidOperationException("No title found");

        var language = NormalizeLanguage(metadata.Element(Dc + "language")?.Value ?? "en");

        var description = metadata.Element(Dc + "description")?.Value;

        var longDescription = metadata.Elements()
            .FirstOrDefault(e => e.Attribute("property")?.Value == "se:long-description")?.Value;

        var authors = ExtractAuthors(metadata);
        var subjects = ExtractSubjects(metadata);
        var wordCount = ExtractWordCount(metadata);

        return new TsMetadata(
            Title: title,
            Description: description,
            LongDescription: longDescription,
            Language: language,
            AuthorNames: authors,
            Subjects: subjects,
            WordCount: wordCount
        );
    }

    private static List<string> ExtractAuthors(XElement metadata)
    {
        var authors = new List<string>();
        var creators = metadata.Elements(Dc + "creator").ToList();

        foreach (var creator in creators)
        {
            var id = creator.Attribute("id")?.Value;
            if (id == null)
            {
                // No id - assume author
                authors.Add(creator.Value);
                continue;
            }

            // Find ALL role metas for this creator
            var roleMetas = metadata.Elements()
                .Where(e =>
                    e.Attribute("refines")?.Value == $"#{id}" &&
                    e.Attribute("property")?.Value == "role" &&
                    e.Attribute("scheme")?.Value == "marc:relators")
                .Select(e => e.Value)
                .ToList();

            // If no roles specified OR "aut" is among roles - it's an author
            if (roleMetas.Count == 0 || roleMetas.Contains("aut"))
                authors.Add(creator.Value);
        }

        return authors;
    }

    private static List<string> ExtractSubjects(XElement metadata)
    {
        return metadata.Elements()
            .Where(e => e.Attribute("property")?.Value == "se:subject")
            .Select(e => e.Value)
            .ToList();
    }

    private static int? ExtractWordCount(XElement metadata)
    {
        var wcElement = metadata.Elements()
            .FirstOrDefault(e => e.Attribute("property")?.Value == "se:word-count");

        if (wcElement != null && int.TryParse(wcElement.Value, out var wc))
            return wc;

        return null;
    }

    private static string NormalizeLanguage(string lang)
    {
        // "en-GB" -> "en", "en-US" -> "en"
        var idx = lang.IndexOf('-');
        return idx > 0 ? lang[..idx] : lang;
    }
}
