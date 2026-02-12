namespace Application.ReadingTracking;

public record AchievementDef(string Code, string Category, string Name, string Description);

public static class AchievementDefinitions
{
    public static readonly Dictionary<string, AchievementDef> All = new()
    {
        // Session milestones
        ["first_session"] = new("first_session", "milestone", "First Steps", "Complete your first reading session"),
        ["first_book"] = new("first_book", "milestone", "Bookworm", "Finish your first book"),
        ["books_5"] = new("books_5", "milestone", "Avid Reader", "Finish 5 books"),
        ["books_10"] = new("books_10", "milestone", "Bibliophile", "Finish 10 books"),
        ["books_25"] = new("books_25", "milestone", "Scholar", "Finish 25 books"),
        ["books_50"] = new("books_50", "milestone", "Grandmaster", "Finish 50 books"),

        // Streak
        ["streak_3"] = new("streak_3", "streak", "Getting Started", "3-day reading streak"),
        ["streak_7"] = new("streak_7", "streak", "Week Warrior", "7-day reading streak"),
        ["streak_14"] = new("streak_14", "streak", "Fortnight Focus", "14-day reading streak"),
        ["streak_30"] = new("streak_30", "streak", "Monthly Master", "30-day reading streak"),
        ["streak_100"] = new("streak_100", "streak", "Century Club", "100-day reading streak"),

        // Time
        ["hours_1"] = new("hours_1", "time", "One Hour Down", "Read for 1 hour total"),
        ["hours_10"] = new("hours_10", "time", "Dedicated", "Read for 10 hours total"),
        ["hours_50"] = new("hours_50", "time", "Committed", "Read for 50 hours total"),
        ["hours_100"] = new("hours_100", "time", "Centurion", "Read for 100 hours total"),

        // Special
        ["early_bird"] = new("early_bird", "special", "Early Bird", "Read between 5-7 AM"),
        ["night_owl"] = new("night_owl", "special", "Night Owl", "Read between 11 PM - 3 AM"),
        ["speed_reader"] = new("speed_reader", "special", "Speed Reader", "Read over 400 words per minute"),
        ["marathon"] = new("marathon", "special", "Marathon", "Single session over 2 hours"),
    };
}
