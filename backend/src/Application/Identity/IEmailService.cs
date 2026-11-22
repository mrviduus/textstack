namespace Application.Identity;

public interface IEmailService
{
    Task SendPasswordResetEmailAsync(string toEmail, string resetToken, CancellationToken ct);

    /// <summary>
    /// Sends an operational alert email (plain HTML) to the configured admin address.
    /// No-op if no admin email is configured. Best-effort — errors are logged, never thrown.
    /// </summary>
    Task SendAdminAlertAsync(string subject, string htmlBody, CancellationToken ct);
}
