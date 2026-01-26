using System.Reflection;
using System.Text.RegularExpressions;

namespace TextStack.Extraction.Spelling;

/// <summary>
/// Removes archaic hyphens from compound words using a dictionary.
/// Ported from Standard Ebooks hyphenation modernization.
/// Uses standard Regex instead of source-generated for ARM64 compatibility.
/// </summary>
public static class HyphenationModernizer
{
    private static readonly Lazy<HashSet<string>> Dictionary = new(LoadDictionary);

    // Match hyphenated words (word-word pattern)
    private static readonly Regex HyphenatedWordRegex = new(@"\b([a-zA-Z]+)-([a-zA-Z]+)\b", RegexOptions.Compiled);

    /// <summary>
    /// Modernize hyphenated words by removing unnecessary hyphens.
    /// E.g., "care-taker" → "caretaker" if "caretaker" is in the dictionary.
    /// </summary>
    public static string ModernizeHyphenation(string html)
    {
        if (string.IsNullOrEmpty(html))
            return html;

        // Find hyphenated words and try to join them
        return HyphenatedWordRegex.Replace(html, match =>
        {
            var original = match.Value;
            var parts = original.Split('-');

            // Only handle two-part hyphenations for now
            if (parts.Length != 2)
                return original;

            // Try combining
            var combined = parts[0] + parts[1];
            var combinedLower = combined.ToLowerInvariant();

            // Check if combined form is in dictionary
            if (Dictionary.Value.Contains(combinedLower))
            {
                // Preserve original capitalization pattern
                return PreserveCapitalization(original, combined);
            }

            return original;
        });
    }

    private static string PreserveCapitalization(string original, string replacement)
    {
        if (string.IsNullOrEmpty(original) || string.IsNullOrEmpty(replacement))
            return replacement;

        // Check if original is all caps
        var originalNoHyphen = original.Replace("-", "");
        if (originalNoHyphen.All(char.IsUpper))
            return replacement.ToUpperInvariant();

        // Check if original is title case (first letter upper)
        if (char.IsUpper(original[0]))
            return char.ToUpperInvariant(replacement[0]) + replacement[1..].ToLowerInvariant();

        // Default to lowercase
        return replacement.ToLowerInvariant();
    }

    private static HashSet<string> LoadDictionary()
    {
        var words = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            var resourceName = "TextStack.Extraction.Spelling.Data.words.txt";

            using var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null)
            {
                // Fallback: use built-in common words
                return GetBuiltInDictionary();
            }

            using var reader = new StreamReader(stream);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                var word = line.Trim();
                if (!string.IsNullOrEmpty(word) && !word.StartsWith('#'))
                {
                    words.Add(word);
                }
            }
        }
        catch
        {
            // If loading fails, use built-in dictionary
            return GetBuiltInDictionary();
        }

        return words;
    }

    private static HashSet<string> GetBuiltInDictionary()
    {
        // Common compound words that should not be hyphenated in modern English
        return new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            // Common compounds
            "anyone", "everyone", "someone", "noone",
            "anything", "everything", "something", "nothing",
            "anywhere", "everywhere", "somewhere", "nowhere",
            "today", "tomorrow", "tonight",
            "cannot", "into", "onto", "upon",
            "within", "without", "throughout",
            "already", "always", "also",

            // Time-related
            "afternoon", "beforehand", "meanwhile", "nowadays",
            "overnight", "sometime", "sometimes", "whatever",
            "whenever", "wherever", "whoever", "whomever",

            // People/occupations
            "caretaker", "housekeeper", "bookkeeper", "gamekeeper",
            "gatekeeper", "goalkeeper", "shopkeeper", "storekeeper",
            "timekeeper", "beekeeper", "innkeeper", "peacekeeper",
            "groundskeeper", "zookeeper",

            // Common words
            "airplane", "bedroom", "bathroom", "classroom",
            "courtyard", "doorway", "driveway", "fireplace",
            "football", "hallway", "headache", "heartbeat",
            "highway", "horseback", "keyboard", "lighthouse",
            "mailbox", "notebook", "outside", "rainbow",
            "raindrop", "railroad", "railway", "seashore",
            "sidewalk", "snowflake", "somebody", "staircase",
            "sunlight", "sunshine", "teacup", "teaspoon",
            "toothbrush", "typewriter", "underground", "upstairs",
            "downstairs", "waterfall", "weekend", "wildlife",
            "windmill", "workshop",

            // Body-related
            "backbone", "barefoot", "birthmark", "bloodstream",
            "brainwash", "eardrum", "eyelash", "eyebrow",
            "fingernail", "fingerprint", "footprint", "forehead",
            "haircut", "handbag", "handbook", "handwriting",
            "headlight", "heartbreak", "kneecap", "lipstick",
            "thumbnail", "toenail",

            // Nature
            "birdhouse", "blackbird", "bluebird", "butterfly",
            "catfish", "cornfield", "dragonfly", "earthquake",
            "earthworm", "farmhouse", "firefly", "goldfish",
            "grasshopper", "greenhouse", "horseshoe", "jellyfish",
            "moonlight", "nightfall", "rattlesnake", "sandcastle",
            "scarecrow", "seagull", "seaside", "snowball",
            "snowman", "starfish", "strawberry", "sunflower",
            "thunderstorm", "watermelon", "windstorm",

            // Actions/states
            "blackmail", "brainstorm", "breakfast", "crossword",
            "daydream", "driftwood", "earthquake", "fingertip",
            "flashlight", "forecast", "frostbite", "guesswork",
            "hamburger", "handshake", "headfirst", "heartfelt",
            "homesick", "horseback", "jailbreak", "landmark",
            "lifeguard", "limestone", "masterpiece", "nightmare",
            "outburst", "outbreak", "outcome", "outdoors",
            "outlaw", "output", "overcome", "overlook",
            "overpower", "overtake", "overwhelm", "pancake",
            "paperwork", "patchwork", "peppermint", "quicksand",
            "railroad", "raincoat", "rattlesnake", "sailboat",
            "sandpaper", "sawdust", "scarecrow", "seashell",
            "silverware", "skateboard", "snowstorm", "southeast",
            "southwest", "spaceship", "spotlight", "springtime",
            "stagecoach", "standpoint", "steamboat", "stockyard",
            "stopwatch", "storehouse", "stronghold", "sunburn",
            "sundown", "sunset", "sunrise", "tablecloth",
            "tablespoon", "tailgate", "takeoff", "teapot",
            "textbook", "therefore", "thoroughfare", "timekeeping",
            "touchstone", "trademark", "treehouse", "turtleneck",
            "uphill", "uplift", "upset", "upstream",
            "volleyball", "wallpaper", "warehouse", "warship",
            "washroom", "wasteland", "watchdog", "watchman",
            "waterfront", "waterproof", "wavelength", "weatherman",
            "wheelbarrow", "wheelbase", "wheelchair", "whirlpool",
            "whitewash", "widespread", "wildfire", "windfall",
            "wingspan", "wintertime", "wishbone", "woodwork",
            "worldwide", "worthwhile", "wristwatch",
        };
    }
}
