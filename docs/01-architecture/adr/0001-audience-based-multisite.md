# ADR-0001: Audience-based multisite (General + Programming)

## Status
Accepted

## Context
TextStack is a content-first, SEO-driven online library platform.
At launch, the project must choose how to structure content and user entry points.

Key observations:
- Technical/programming literature has strong long-tail SEO potential and a clear audience.
- Student-oriented content (textbooks, introductory materials, science basics) has broader reach and lower entry barrier.
- Users think in terms of "who this is for", not in strict content categories.
- Maintaining multiple platforms or databases would significantly increase complexity for an early-stage project.

We need a structure that:
- Supports clear audience targeting
- Allows fast content ingestion without over-classification
- Scales to additional verticals in the future
- Keeps architecture simple and durable

## Decision
We adopt an **audience-based multisite model** with a **single platform** and **multiple sites**.

At launch, the platform will have two sites:

1. **General**
   - Primary audience: students and self-learners
   - Acts as a broad, student-first aggregator
   - Can contain all types of literature (including programming, science, fiction, etc.)
   - Serves as the main entry point and fallback for all content

2. **Programming**
   - Primary audience: programmers and software engineers
   - Dedicated vertical for technical and programming literature
   - Optimized for developer-focused UX and SEO
   - Contains a curated subset of content relevant to programming

Key constraints:
- One backend
- One database
- One ingestion pipeline
- One reader implementation
- Separation is done via **Site** as a first-class domain concept, not via separate applications

## Consequences

### Positive
- Clear audience targeting without fragmenting the platform
- Faster launch: content can always be published to General
- Strong SEO strategy: vertical (Programming) + horizontal (General)
- Easy future expansion (e.g. Science, Education) by adding new sites
- Minimal operational and maintenance overhead

### Negative
- Requires explicit Site resolution (e.g. via Host header)
- Requires content-to-site mapping rules
- SEO must be carefully managed to avoid internal competition between sites

## Notes
- "General" is intentionally student-first, not a vague catch-all.
- Programming is the only explicit vertical at launch.
- Additional sites should only be added after validating traffic and content flow.