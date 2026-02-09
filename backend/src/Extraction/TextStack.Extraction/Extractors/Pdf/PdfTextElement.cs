namespace TextStack.Extraction.Extractors.Pdf;

public enum TextElementType
{
    Heading,
    Paragraph,
    Image
}

public sealed record PdfTextElement(
    TextElementType Type,
    string Text,
    bool IsBold,
    bool IsItalic,
    double YPosition = 0
);
