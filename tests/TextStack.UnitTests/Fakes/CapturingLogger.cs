using Microsoft.Extensions.Logging;

namespace TextStack.UnitTests.Fakes;

/// <summary>An <see cref="ILogger{T}"/> that keeps every entry: level, formatted message and exception.</summary>
public sealed class CapturingLogger<T> : ILogger<T>
{
    public List<(LogLevel Level, string Message, Exception? Exception)> Entries { get; } = [];

    public IEnumerable<(LogLevel Level, string Message, Exception? Exception)> Errors => Entries.Where(e => e.Level == LogLevel.Error);

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
        Entries.Add((logLevel, formatter(state, exception), exception));
}
