---
status: accepted
date: 2026-09-08
---

# Centralize OCR and AI processing in the Rhea backend

Rhea V1 will perform OCR, generative AI, grading assistance, and learning-state calculation only in backend processes. The React Native/Expo client remains responsible for capture, page arrangement, encrypted offline drafts, upload, progress, cancellation, content confirmation, and presentation.

This decision covers both direct calls to managed providers and locally hosted inference. The client must not contain provider credentials, direct provider endpoints, OCR/AI provider SDKs, or logic that can publish model output as learning state.

## Considered options

- **On-device OCR and AI:** technically possible and potentially faster or offline-capable, but it would fragment model/version governance, increase device variance and binary complexity, and make cancellation, consent, safety, quality, and retention enforcement harder to prove.
- **Client calls managed OCR/AI providers directly:** reduces backend proxy traffic, but exposes provider access material and lets data leave Rhea's controlled processing boundary before server-side authorization, minimization, and lifecycle checks.
- **Backend-centralized processing (selected):** adds network dependency, upload latency, backend cost, and capacity requirements, but provides one enforceable boundary for authorization, provider routing, quality, privacy, cancellation, observability, and deletion.

## Consequences

- The client may preview the camera, rotate/crop/order/delete/retake pages, check files and network state, show upload progress, and keep an application-sandboxed encrypted upload draft while offline. It performs no OCR, generative inference, grading, or authoritative learning-state transition.
- The backend issues short-lived presigned URLs for Rhea's private object storage, then asynchronously performs file security, quality, privacy preprocessing, OCR, structure extraction, AI generation, deterministic checks, and domain publication.
- Processing jobs expose resumable phases: `security_check`, `quality_check`, `recognizing`, `awaiting_confirmation`, `grading`, and `completed`, plus `canceled`, `failed`, and `unavailable` terminal states.
- MVP enables one signed-off primary production OCR adapter per capability. Any fallback provider and capability version must be approved in advance for quality, region, retention, and safety; otherwise the result is explicitly unavailable.
- Generative models receive confirmed structured text, the current learning basis, and only the minimum necessary question crop by default. Whole-page raw images are not sent to generative models without a separately signed-off multimodal purpose.
- OCR and model output remain candidates. Deterministic backend modules own content confirmation, accepted assessments, errors, evidence, mastery, reports, and challenge state.
- After content confirmation, Rhea deletes the whole-page raw image by default and retains only structured content, a source summary/hash, and necessary minimal question crops. A guardian's explicit choice to save material uses a separate storage class and lifecycle. If later dispute evidence is insufficient, Rhea requests a new capture.
- Cancellation or AI-consent revocation immediately prevents publication. Late provider responses are isolated and deleted; they cannot enter questions, grading, errors, learning state, reports, learning metrics, or product metrics.
- Offline use can capture an encrypted upload draft but cannot produce OCR, grading, or AI results until connectivity returns.

See [Rhea technical architecture V1](../architecture/rhea-technical-architecture-v1.md) for the implementation boundary, workflows, and verification rules.
