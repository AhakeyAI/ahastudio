// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

export const TERMINAL_HTTP_URL_MAX_LENGTH = 2048

// Punctuation-only continuation rows are valid, so URL length also bounds framed row count.
export const TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS = TERMINAL_HTTP_URL_MAX_LENGTH
