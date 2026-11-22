namespace Domain.Common;

public class DomainException : Exception
{
    public string Code { get; }

    public DomainException(string code, string message) : base(message)
    {
        Code = code;
    }
}

public class NotFoundException : DomainException
{
    public NotFoundException(string entity, object id)
        : base("NOT_FOUND", $"{entity} with id '{id}' not found") { }
}

public class ConflictException : DomainException
{
    public ConflictException(string message)
        : base("CONFLICT", message) { }
}

public class ValidationException : DomainException
{
    public IDictionary<string, string[]> Errors { get; }

    public ValidationException(IDictionary<string, string[]> errors)
        : base("VALIDATION_ERROR", "One or more validation errors occurred")
    {
        Errors = errors;
    }

    public ValidationException(string field, string error)
        : this(new Dictionary<string, string[]> { { field, [error] } }) { }
}
