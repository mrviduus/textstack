namespace Contracts.Agents;

/// <summary>Request to start (or resume) a Tutor session (AI-Agent-2). <see cref="MaxItems"/> is optional (server-capped).</summary>
public record TutorStartRequest(int? MaxItems);

/// <summary>One learner result fed back to the tutor for re-planning: the card answered + correctness + latency.</summary>
public record TutorFeedbackResultDto(Guid WordId, bool Correct, int ResponseTimeMs);

/// <summary>Request to submit the learner's results for the current session and get the re-planned remainder.</summary>
public record TutorFeedbackRequest(IReadOnlyList<TutorFeedbackResultDto> Results);

/// <summary>
/// One answer, recorded the moment it is given. Separate from
/// <see cref="TutorFeedbackRequest"/> because that one re-plans the session — several LLM calls —
/// and an answer must not have to wait for planning to be worth anything.
/// </summary>
public record TutorAnswerRequest(Guid WordId, bool Correct, int ResponseTimeMs);

/// <summary>
/// One planned study item in the Tutor response. <see cref="WordId"/> + <see cref="Word"/> reference a REAL
/// vocab card (re-projected from a tool result — never invented). <see cref="ExerciseType"/> is calibrated to
/// the card's SRS <see cref="Stage"/> (recognition / recall / context), <see cref="Difficulty"/> to stage +
/// accuracy, and <see cref="Why"/> is the per-item reasoning.
/// <para>
/// The render fields are enriched server-side from the caller's REAL <c>VocabularyWord</c> row (keyed on the
/// already-validated <see cref="WordId"/>) so the client can draw the card without a fragile re-fetch+join.
/// An item whose id no longer maps to one of the caller's cards is dropped, not emitted with null render
/// fields.
/// </para>
/// <para>
/// <b>The card is shaped here, not on the client.</b> <see cref="ExerciseType"/> used to be advisory — every
/// client built the same flashcard from raw distractors and rendered the type as a badge, so a calibration
/// the server had computed changed nothing a learner saw. The options are now built by the same
/// <c>McOptions</c> the vocabulary-review flow uses, and the shape follows the exercise:
/// <list type="bullet">
///   <item><c>recognition</c> — four options, no sentence prompt: "which word means this".</item>
///   <item><c>recall</c> — no options. A flashcard the learner answers honestly against themselves,
///   which is the whole point of the stage.</item>
///   <item><c>context</c> — four options AND <see cref="BlankSentence"/>: the cloze, in the sentence
///   the word was saved from.</item>
/// </list>
/// A client that ignores the new fields still renders what it always did, so this is additive on the wire.
/// </para>
/// </summary>
public record TutorPlanItemDto(
    Guid WordId,
    string Word,
    int Stage,
    string ExerciseType,
    string Difficulty,
    string Why,
    string? Translation,
    string? Definition,
    string? Sentence,
    string? BookTitle,
    string? Hint,
    IReadOnlyList<string> Distractors,
    /// <summary>The four choices, shuffled — null for <c>recall</c>, which has no options by design.</summary>
    IReadOnlyList<string>? Options = null,
    /// <summary>Index of the right answer in <see cref="Options"/>; null whenever Options is.</summary>
    int? CorrectOptionIndex = null,
    /// <summary>The saved sentence with the word removed. Only for <c>context</c>.</summary>
    string? BlankSentence = null);

/// <summary>
/// The Tutor agent's response: the persisted <see cref="SessionId"/> (carry it to the feedback endpoint), the
/// ordered <see cref="Plan"/>, the overall <see cref="Rationale"/>, a closing <see cref="ReadingNudge"/> (the
/// thesis), and the per-turn <see cref="RunId"/> for replay in the admin AI-quality UI.
/// </summary>
public record TutorSessionResponse(
    Guid SessionId,
    IReadOnlyList<TutorPlanItemDto> Plan,
    string Rationale,
    string ReadingNudge,
    Guid RunId);
