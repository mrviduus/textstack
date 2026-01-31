import { useState } from 'react'

interface FAQItem {
  question: string
  answer: string
}

interface SeoContentFieldsetProps {
  aboutText: string
  onAboutTextChange: (value: string) => void
  relevanceText: string
  onRelevanceTextChange: (value: string) => void
  themes: string[]
  onThemesChange: (value: string[]) => void
  faqs: FAQItem[]
  onFaqsChange: (value: FAQItem[]) => void
}

export function SeoContentFieldset({
  aboutText,
  onAboutTextChange,
  relevanceText,
  onRelevanceTextChange,
  themes,
  onThemesChange,
  faqs,
  onFaqsChange,
}: SeoContentFieldsetProps) {
  const [newTheme, setNewTheme] = useState('')
  const [newFaqQ, setNewFaqQ] = useState('')
  const [newFaqA, setNewFaqA] = useState('')

  const handleAddTheme = () => {
    if (newTheme.trim()) {
      onThemesChange([...themes, newTheme.trim()])
      setNewTheme('')
    }
  }

  const handleRemoveTheme = (index: number) => {
    onThemesChange(themes.filter((_, i) => i !== index))
  }

  const handleAddFaq = () => {
    if (newFaqQ.trim() && newFaqA.trim()) {
      onFaqsChange([...faqs, { question: newFaqQ.trim(), answer: newFaqA.trim() }])
      setNewFaqQ('')
      setNewFaqA('')
    }
  }

  const handleRemoveFaq = (index: number) => {
    onFaqsChange(faqs.filter((_, i) => i !== index))
  }

  const handleUpdateFaq = (index: number, field: 'question' | 'answer', value: string) => {
    const updated = [...faqs]
    updated[index] = { ...updated[index], [field]: value }
    onFaqsChange(updated)
  }

  return (
    <fieldset className="form-fieldset">
      <legend>SEO Content Blocks (overrides auto-generated)</legend>

      <div className="form-group">
        <label htmlFor="seoAboutText">About Text</label>
        <textarea
          id="seoAboutText"
          value={aboutText}
          onChange={(e) => onAboutTextChange(e.target.value)}
          rows={3}
          placeholder="Leave empty to auto-generate from description"
          maxLength={1000}
        />
        <small>Appears in "What is [title] about?" section</small>
      </div>

      <div className="form-group">
        <label htmlFor="seoRelevanceText">Relevance Text</label>
        <textarea
          id="seoRelevanceText"
          value={relevanceText}
          onChange={(e) => onRelevanceTextChange(e.target.value)}
          rows={3}
          placeholder="Leave empty to auto-generate"
          maxLength={1000}
        />
        <small>Appears in "Why [title] is still relevant today" section</small>
      </div>

      <div className="form-group">
        <label>Themes</label>
        <div className="tags-input">
          {themes.map((theme, i) => (
            <span key={i} className="tag">
              {theme}
              <button type="button" onClick={() => handleRemoveTheme(i)} className="tag__remove">&times;</button>
            </span>
          ))}
        </div>
        <div className="inline-add">
          <input
            type="text"
            value={newTheme}
            onChange={(e) => setNewTheme(e.target.value)}
            placeholder="Add theme..."
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTheme())}
          />
          <button type="button" onClick={handleAddTheme} className="btn btn--small">Add</button>
        </div>
        <small>Leave empty to auto-extract from description</small>
      </div>

      <div className="form-group">
        <label>FAQ Items</label>
        {faqs.length > 0 && (
          <div className="faq-list">
            {faqs.map((faq, i) => (
              <div key={i} className="faq-item">
                <div className="faq-item__fields">
                  <input
                    type="text"
                    value={faq.question}
                    onChange={(e) => handleUpdateFaq(i, 'question', e.target.value)}
                    placeholder="Question"
                  />
                  <textarea
                    value={faq.answer}
                    onChange={(e) => handleUpdateFaq(i, 'answer', e.target.value)}
                    placeholder="Answer"
                    rows={2}
                  />
                </div>
                <button type="button" onClick={() => handleRemoveFaq(i)} className="btn btn--small btn--danger">Remove</button>
              </div>
            ))}
          </div>
        )}
        <div className="faq-add">
          <input
            type="text"
            value={newFaqQ}
            onChange={(e) => setNewFaqQ(e.target.value)}
            placeholder="New question..."
          />
          <textarea
            value={newFaqA}
            onChange={(e) => setNewFaqA(e.target.value)}
            placeholder="Answer..."
            rows={2}
          />
          <button type="button" onClick={handleAddFaq} className="btn btn--small">Add FAQ</button>
        </div>
        <small>Leave empty to auto-generate standard FAQs</small>
      </div>
    </fieldset>
  )
}
