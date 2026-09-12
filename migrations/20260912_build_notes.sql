-- Free-text notes on a build, same single-overwritable-field convention as
-- parts.notes (see manufacture/+page.svelte's "Add notes for this part"
-- textarea) - a place for context, blockers, or status that doesn't fit
-- anywhere else on the build detail page.
alter table builds add column if not exists notes text;
