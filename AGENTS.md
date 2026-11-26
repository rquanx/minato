# Minato iteration guidelines

## Product and architecture

- Keep application integrations stable through project, environment and feature aliases. Handle catalog changes, model selection, fallback and change notifications in Minato.
- Design related actions as complete workflows. OAuth and credential import converge on reusable subscription accounts. A configured webhook can be tested from its own row. Call investigation connects usage, searchable calls, captured content and replay.
- Reuse proven provider and runtime capabilities where they fit. Use CPA as a protocol reference where applicable and track real-provider acceptance separately from mock coverage. Keep high-frequency paths in the Go runtime and enable compatibility services as needed. Expose reusable runtime settings that Minato can compose. Scope cost work to trends and add enterprise features when needed.

## Console UI

## Component strategy

- Use Minato's shared React components in `apps/web/src/components.tsx` and the tokens in `apps/web/src/style.css`. Use Radix Primitives for complex input behavior, starting with Select. Keep styling in Minato and use browser semantics for simple inputs, forms, tables and dialogs. Reference [Radix Select](https://www.radix-ui.com/primitives/docs/components/select) for keyboard and focus behavior and [Carbon's spacing scale](https://www.carbondesignsystem.com/building-blocks/foundations/spacing/overview) for layout rhythm.
- Use Inter at 14 px for control text, 12 px for supporting text and 16 px for panel titles. Use Lucide icons at 16 px in controls. Give icon-only controls an accessible name, and use tabular numerals for metrics and table values.
- Use `Field` with `Input` or `Textarea` for labeled text entry, `FileField` for uploads, `Disclosure` for expandable content and `ButtonLink` for links styled as actions. Keep file selection, selected filename, format hints and form submission consistent across providers.
- Fix recurring control issues in the shared component or design tokens. Check other screens that use the control and verify a normal flow, keyboard focus, disabled or pending states, and a narrow viewport. Compare computed dimensions and spacing across related controls.

## Sizes and states

- Use a 4 px spacing scale with shared steps of 4, 8, 12, 16, 20, 24 and 32 px. Use 8 px between related controls, 16 px between form rows, 20 px inside a panel, and 24 px between major sections. Left-align labels with their controls and use a single column when two fields cannot remain readable side by side.
- Use 40 px for standard buttons, text inputs and Select triggers. Use a 44 px minimum for these controls and option rows on touch devices. Use 8 px corner radii for controls, 12 px for panels, and a shared focus ring. Use shared hover, focus, selected, disabled and invalid states with text or an icon where a color change alone is ambiguous.
- Give every Select an accessible label. Use a short visible label in standalone forms. In toolbar filters and clearly titled groups, use a self-explanatory value or placeholder and keep the label accessible to screen readers. Let the trigger provide the visible border. Use a selectable “All …” option for optional filters. Keep the chevron fixed, truncate long trigger labels and show the full text in the menu. Menus align to the trigger, flip near viewport edges, cap their height and scroll. Preserve Arrow keys, typeahead, Enter/Space, Escape and focus return. Prefer searchable comboboxes when users routinely choose from large or remote catalogs.
- Edit feature models as one ordered list. Keep move controls together and separate removal from reordering. Clearing a field keeps its row intact. Preview the resolved attempt order in one list with each model's origin, including environment defaults. Show skipped candidates and their reasons on demand. Label the preview and the serving version distinctly.
- Use primary, secondary, navigation, icon, text and destructive button variants for their respective roles. Use checkboxes for settings saved in a form, and switches for settings applied immediately. Keep field hints outside placeholders, associate errors with their fields and lock submission while a form is pending.
- Use shared loading, empty and error states. Put retry next to a failed load. Use the shared confirmation dialog for destructive actions, with a named action and a separate Cancel button. Return focus to the initiating control when the dialog closes.
- Use a centered modal for short previews opened from another dialog. Allow a click on the backdrop to dismiss only the top dialog. Keep Escape and the close button available, and keep dialogs open while a submission is pending.

## Page and data presentation

- Put the main task and its filters at the top of each page. Use sections for distinct tasks, and open record details and creation forms in a drawer. Use aligned labels, shared spacing, and a clear primary action.
- Place record actions on the corresponding row. Keep common information visible in a compact list, with details on demand. Show route history inline with a timestamp and state per version. Put configuration preview and confirmed rollback on the version row. In the preview, show the attempt order once and offer the saved configuration when it differs.
- Keep information users compare in the same view. In Test and Replay, show request and result side by side where space allows and stack them in reading order on narrow screens.
- Use server cursor pagination for calls and other growing history lists. Paginate collections that are already loaded in memory. Reset pagination when the scope or filters change.
- Design Calls around precise request and correlation ID lookup plus combinable incident filters. Design Usage around trends and breakdowns by the dimensions users act on. Evaluate growing search and reporting paths with representative data volume and capture rates.
- Right align numeric table cells and keep timestamps together. Allow tables to scroll inside their card on narrow screens, including from the keyboard. Give chart series one Tab stop and use arrow keys to inspect individual dates.
- Keep chart cards on a common baseline. Use one trend header, 16 px from the value row to the plot and 8 px from the plot to date labels. Use fixed chart geometry while hover, touch or keyboard focus updates the selected day's value. Label scale and units, keep date ticks sparse on narrow screens, distinguish zero from unavailable values and provide the same data in an accessible table.
