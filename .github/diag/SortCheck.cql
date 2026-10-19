library SortCheck version '1.0.0'

using FHIR version '4.0.1'

context Unfiltered

define "Default offset": timezoneoffset from @2026-05-15T

// 1. A day-precision DateTime against a timed one in another offset (the patch's inconsistent pair).
define "DateOnly vs -12 asc": ({ @2026-05-14T00:00:00.000-12:00, @2026-05-15T }) X sort asc
define "DateOnly vs -12 asc, reversed input": ({ @2026-05-15T, @2026-05-14T00:00:00.000-12:00 }) X sort asc
define "DateOnly vs -12 Last": Last(({ Tuple { id: 'timed 14th', d: @2026-05-14T00:00:00.000-12:00 }, Tuple { id: 'date-only 15th', d: @2026-05-15T } }) X sort by d).id
define "DateOnly vs -12 Last, reversed input": Last(({ Tuple { id: 'date-only 15th', d: @2026-05-15T }, Tuple { id: 'timed 14th', d: @2026-05-14T00:00:00.000-12:00 } }) X sort by d).id

// 2. The #750 example: two timed readings in different offsets, the -10:00 one is the newer instant.
define "750 Last": Last(({ Tuple { id: 'older 05:00Z', d: @2025-01-02T05:00:00.000Z }, Tuple { id: 'newer 06:00Z', d: @2025-01-01T20:00:00.000-10:00 } }) X sort by d).id
define "750 Last, reversed input": Last(({ Tuple { id: 'newer 06:00Z', d: @2025-01-01T20:00:00.000-10:00 }, Tuple { id: 'older 05:00Z', d: @2025-01-02T05:00:00.000Z } }) X sort by d).id

// 3. Ties: the same instant, in different offsets and in one offset.
define "Tie, two offsets Last": Last(({ Tuple { id: 'listed first', d: @2026-05-15T10:00:00.000-10:00 }, Tuple { id: 'listed second', d: @2026-05-15T20:00:00.000Z } }) X sort by d).id
define "Tie, two offsets Last, reversed input": Last(({ Tuple { id: 'listed first', d: @2026-05-15T20:00:00.000Z }, Tuple { id: 'listed second', d: @2026-05-15T10:00:00.000-10:00 } }) X sort by d).id
define "Tie, one offset Last": Last(({ Tuple { id: 'listed first', d: @2026-05-15T10:00:00.000-10:00 }, Tuple { id: 'listed second', d: @2026-05-15T10:00:00.000-10:00 } }) X sort by d).id

// 4. A day-precision DateTime against a timed one on the same day, one offset.
define "Same day, one offset Last": Last(({ Tuple { id: 'timed', d: @2026-05-15T10:00:00.000+00:00 }, Tuple { id: 'date-only', d: @2026-05-15T } }) X sort by d).id
define "Same day, one offset Last, reversed input": Last(({ Tuple { id: 'date-only', d: @2026-05-15T }, Tuple { id: 'timed', d: @2026-05-15T10:00:00.000+00:00 } }) X sort by d).id
