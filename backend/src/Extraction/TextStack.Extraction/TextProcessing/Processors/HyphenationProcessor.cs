using System.Reflection;
using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Removes archaic hyphens from compound words using a dictionary.
/// </summary>
public class HyphenationProcessor : ITextProcessor
{
    public string Name => "Hyphenation";
    public int Order => 500;

    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(100);
    private static readonly Lazy<HashSet<string>> Dictionary = new(LoadDictionary);
    private static readonly Regex HyphenatedWordRegex = new(@"\b([a-zA-Z]+)-([a-zA-Z]+)\b", RegexOptions.Compiled, RegexTimeout);

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        return HyphenatedWordRegex.Replace(input, match =>
        {
            var original = match.Value;
            var parts = original.Split('-');

            if (parts.Length != 2)
                return original;

            var combined = parts[0] + parts[1];
            var combinedLower = combined.ToLowerInvariant();

            if (Dictionary.Value.Contains(combinedLower))
                return PreserveCapitalization(original, combined);

            return original;
        });
    }

    private static string PreserveCapitalization(string original, string replacement)
    {
        if (string.IsNullOrEmpty(original) || string.IsNullOrEmpty(replacement))
            return replacement;

        var originalNoHyphen = original.Replace("-", "");
        if (originalNoHyphen.All(char.IsUpper))
            return replacement.ToUpperInvariant();

        if (char.IsUpper(original[0]))
            return char.ToUpperInvariant(replacement[0]) + replacement[1..].ToLowerInvariant();

        return replacement.ToLowerInvariant();
    }

    private static HashSet<string> LoadDictionary()
    {
        var words = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            var resourceName = "TextStack.Extraction.TextProcessing.Data.words.txt";

            using var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null)
                return GetBuiltInDictionary();

            using var reader = new StreamReader(stream);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                var word = line.Trim();
                if (!string.IsNullOrEmpty(word) && !word.StartsWith('#'))
                    words.Add(word);
            }
        }
        catch
        {
            return GetBuiltInDictionary();
        }

        return words;
    }

    private static HashSet<string> GetBuiltInDictionary()
    {
        return new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "anyone", "everyone", "someone", "noone",
            "anything", "everything", "something", "nothing",
            "anywhere", "everywhere", "somewhere", "nowhere",
            "today", "tomorrow", "tonight",
            "cannot", "into", "onto", "upon",
            "within", "without", "throughout",
            "already", "always", "also",
            "afternoon", "beforehand", "meanwhile", "nowadays",
            "overnight", "sometime", "sometimes", "whatever",
            "whenever", "wherever", "whoever", "whomever",
            "caretaker", "housekeeper", "bookkeeper", "gamekeeper",
            "gatekeeper", "goalkeeper", "shopkeeper", "storekeeper",
            "timekeeper", "beekeeper", "innkeeper", "peacekeeper",
            "groundskeeper", "zookeeper",
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
            "backbone", "barefoot", "birthmark", "bloodstream",
            "brainwash", "eardrum", "eyelash", "eyebrow",
            "fingernail", "fingerprint", "footprint", "forehead",
            "haircut", "handbag", "handbook", "handwriting",
            "headlight", "heartbreak", "kneecap", "lipstick",
            "thumbnail", "toenail",
            "birdhouse", "blackbird", "bluebird", "butterfly",
            "catfish", "cornfield", "dragonfly", "earthquake",
            "earthworm", "farmhouse", "firefly", "goldfish",
            "grasshopper", "greenhouse", "horseshoe", "jellyfish",
            "moonlight", "nightfall", "rattlesnake", "sandcastle",
            "scarecrow", "seagull", "seaside", "snowball",
            "snowman", "starfish", "strawberry", "sunflower",
            "thunderstorm", "watermelon", "windstorm",
            "blackmail", "brainstorm", "breakfast", "crossword",
            "daydream", "driftwood", "fingertip",
            "flashlight", "forecast", "frostbite", "guesswork",
            "hamburger", "handshake", "headfirst", "heartfelt",
            "homesick", "jailbreak", "landmark",
            "lifeguard", "limestone", "masterpiece", "nightmare",
            "outburst", "outbreak", "outcome", "outdoors",
            "outlaw", "output", "overcome", "overlook",
            "overpower", "overtake", "overwhelm", "pancake",
            "paperwork", "patchwork", "peppermint", "quicksand",
            "raincoat", "sailboat",
            "sandpaper", "sawdust", "seashell",
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
