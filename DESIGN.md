# Design

## Source of truth
- Status: Draft
- Last refreshed: 2026-06-21
- Primary product surfaces: Desktop Assistant main window, drawer navigation, memo/automation overlays, utility manager windows, Automation flow editor.
- Evidence reviewed: `packages/desktop-assistant/renderer/src/App.tsx`, `packages/desktop-assistant/renderer/src/components/Drawer.tsx`, `packages/desktop-assistant/renderer/src/memo/MemoView.tsx`, `packages/desktop-assistant/renderer/src/mcp/McpManagerView.tsx`, `packages/desktop-assistant/renderer/src/personal-skills/PersonalSkillManagerView.tsx`, `packages/desktop-assistant/renderer/src/styles.css`, `packages/desktop-assistant/renderer/src/APP_STRUCTURE.md`, attached Automation plan.

## Brand
- Personality: quiet, capable, desktop-native, glassy dark interface.
- Trust signals: visible run status, explicit enable/disable, history, confirmations for risky actions.
- Avoid: separate dashboard aesthetics, React Flow default light styling, marketing layouts, nested card stacks.

## Product goals
- Goals: let users create reusable desktop workflows, schedule them, test them, and inspect history without leaving the assistant.
- Non-goals: replacing the main chat with a full IDE, making automation tools available in ordinary chat design mode, auto-compensating missed desktop actions.
- Success signals: drawer entry is easy to find, flows survive restart, scheduled/manual/test runs produce visible status and history.

## Personas and jobs
- Primary personas: desktop assistant users with repeated workflows; power users designing AI-assisted flows.
- User jobs: define a flow, edit graph steps, ask AI to draft graph changes, run/test, enable schedules, review prior runs.
- Key contexts of use: Windows desktop, compact/expanded assistant window, utility editor window.

## Information architecture
- Primary navigation: drawer entry `Automation` between Home and Memo.
- Core routes/screens: `automation` overlay for flow management; `automation-editor` utility window for graph design.
- Content hierarchy: flow list first, selected flow detail second, run history and graph metadata as supporting information.

## Design principles
- Principle 1: Mirror Memo for management surfaces so automation feels native to the assistant.
- Principle 2: Keep flow editing in a utility window so complex graph work does not crowd the main chat.
- Tradeoffs: v1 prioritizes a working end-to-end graph/run/history loop over advanced inspector menus.

## Visual language
- Color: existing dark glass variables, with accent/success/warn/danger used for state.
- Typography: existing UI scale; compact headings inside panels.
- Spacing/layout rhythm: dense but readable management screens, stable split-pane editor.
- Shape/radius/elevation: reuse existing small-to-medium radii and thin borders; no nested cards.
- Motion: preserve existing overlay transitions; keep editor controls steady.
- Imagery/iconography: lucide icons for nav/actions; React Flow graph is the primary visual asset.

## Components
- Existing components to reuse: `TitleBar`, drawer nav items, memo-style cards, utility-window titlebar patterns.
- New/changed components: `AutomationView`, `FlowEditorView`, automation flow cards, run history rows, graph editor panels.
- Variants and states: empty, loading, enabled, disabled, running, succeeded, failed, cancelled, missed schedule.
- Token/component ownership: `styles.css` owns app tokens and automation-specific classes.

## Accessibility
- Target standard: keyboard-usable controls and readable contrast within current app constraints.
- Keyboard/focus behavior: buttons/inputs/selects remain native focusable; graph controls should not trap focus.
- Contrast/readability: state pills and buttons must use existing high-contrast foreground tokens.
- Screen-reader semantics: controls use button/input/select semantics; icon-only buttons require labels or titles where unfamiliar.
- Reduced motion and sensory considerations: no essential information depends on animation.

## Responsive behavior
- Supported breakpoints/devices: desktop Electron windows, compact main window, larger utility editor window.
- Layout adaptations: automation overlay collapses detail/list gracefully; editor uses stable split panes and wraps toolbars.
- Touch/hover differences: hover is enhancement only; all actions are clickable buttons.

## Interaction states
- Loading: lightweight status text or empty lists.
- Empty: create-flow prompt in AutomationView.
- Error: inline status text near the current operation.
- Success: saved/running history updates in-place.
- Disabled: disabled buttons during save/run.
- Offline/slow network, if applicable: model/API failures surface as run failures or inline status.

## Content voice
- Tone: concise operational English in code/UI additions, matching existing technical UI.
- Terminology: flow, trigger, run, history, editor, test.
- Microcopy rules: state what happened; avoid explaining how to use obvious controls in-page.

## Implementation constraints
- Framework/styling system: React, Electron preload IPC, existing CSS variables, lucide icons, `@xyflow/react`.
- Design-token constraints: use `styles.css` variables and existing app classes; avoid a separate design system.
- Performance constraints: one scheduler timer per enabled flow; editor graph state stays bounded for v1.
- Compatibility constraints: no ordinary chat injection of `flow_*`/`automation_*`; missed scheduled automations are not auto-run on startup.
- Test/screenshot expectations: unit tests cover repository, scheduler, and runbook; typecheck/check must pass.

## Open questions
- [ ] Whether automation run policy should map deeper into sandbox per-tool confirmation thresholds / owner: product+engineering / impact: high-risk action UX.
- [ ] Whether design chat should stream partial AI responses into the editor / owner: frontend / impact: perceived responsiveness.
