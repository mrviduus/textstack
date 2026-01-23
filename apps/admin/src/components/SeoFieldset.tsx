interface SeoFieldsetProps {
  indexable: boolean
  onIndexableChange: (value: boolean) => void
  seoTitle: string
  onSeoTitleChange: (value: string) => void
  seoDescription: string
  onSeoDescriptionChange: (value: string) => void
  canonicalOverride?: string
  onCanonicalOverrideChange?: (value: string) => void
  titlePlaceholder?: string
  indexableDisabled?: boolean
  indexableHint?: string
  showCanonical?: boolean
}

export function SeoFieldset({
  indexable,
  onIndexableChange,
  seoTitle,
  onSeoTitleChange,
  seoDescription,
  onSeoDescriptionChange,
  canonicalOverride = '',
  onCanonicalOverrideChange,
  titlePlaceholder = 'Auto-generated',
  indexableDisabled = false,
  indexableHint,
  showCanonical = true,
}: SeoFieldsetProps) {
  return (
    <fieldset className="form-fieldset">
      <legend>SEO Settings</legend>

      <div className="form-group form-group--checkbox">
        <label>
          <input
            type="checkbox"
            checked={indexable}
            onChange={(e) => onIndexableChange(e.target.checked)}
            disabled={indexableDisabled}
          />
          Indexable by search engines
        </label>
        {indexableHint && <small className="form-hint">{indexableHint}</small>}
      </div>

      <div className="form-group">
        <label htmlFor="seoTitle">SEO Title (overrides default)</label>
        <input
          type="text"
          id="seoTitle"
          value={seoTitle}
          onChange={(e) => onSeoTitleChange(e.target.value)}
          placeholder={titlePlaceholder}
          maxLength={160}
        />
        <small>{seoTitle.length}/160</small>
      </div>

      <div className="form-group">
        <label htmlFor="seoDescription">SEO Description</label>
        <textarea
          id="seoDescription"
          value={seoDescription}
          onChange={(e) => onSeoDescriptionChange(e.target.value)}
          rows={3}
          placeholder="Auto-generated from description"
          maxLength={320}
        />
        <small>{seoDescription.length}/320</small>
      </div>

      {showCanonical && onCanonicalOverrideChange && (
        <div className="form-group">
          <label htmlFor="canonicalOverride">Canonical URL Override</label>
          <input
            type="url"
            id="canonicalOverride"
            value={canonicalOverride}
            onChange={(e) => onCanonicalOverrideChange(e.target.value)}
            placeholder="Leave empty for default"
          />
        </div>
      )}
    </fieldset>
  )
}
