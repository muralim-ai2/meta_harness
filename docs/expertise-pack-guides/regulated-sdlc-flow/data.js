/** Clickable 1920x1080 flow map: how ARIA routes, governs and ships an ask with the regulated-sdlc expertise pack and STD-SEC-2026. */
window.INFOGRAPHIC = {
  meta: {
    eyebrow: 'ARIA Expertise Packs \u00b7 Regulated Enterprise SDLC',
    title: 'How a Regulated SDLC Pack Routes, Governs & Ships Work',
    sub: 'How ARIA Auto and ARIA Collab match aria-plugin.json, load STD-SEC-2026 on demand, and gate InfoSec and UAT via lifecycle.py.',
    mark: 'shield',
    foot: 'Click any stage, step or pack asset for exact CLI calls, manifest rules and links to the guide.',
    exportFoot: 'ARIA 0.28.5 \u00b7 Expertise Pack Flow Map (regulated-sdlc + STD-SEC-2026)',
  },
  layout: 'lanes',
  kinds: {
    primary: { label: 'Stage', style: 'accent' },
    step: { label: 'Step', style: 'bar' },
    optional: { label: 'Brief', style: 'dashed' },
    gate: { label: 'Gate', style: 'muted' },
  },
  arrow: 'Flows to',
  icons: {
    aria: '<path d="M12.2 3.4c.5 0 .9.3 1 .8l3.9 12.6a.8.8 0 0 1-1.5.5L12.1 6.6 9.9 15.3c.5 1.4-.4 3-2 3.5-1.7.5-3.3-.1-3.6-1.4-.3-1.3.9-2.8 2.6-3.3.3-.1.6-.1.9-.1l3.4-9.8c.2-.5.6-.8 1-.8Z"/><circle cx="18.6" cy="17.6" r="1.5"/>',
  },
  rail: { title: 'Entry', foot: 'Ask to ship' },
  lanes: [
    {
      entries: [{ id: 'r-ask', icon: 'chat', label: 'Request', to: 'm-route', start: 'Start here' }],
      main: {
        id: 'm-route', icon: 'search', title: 'Route Request', via: 'lifecycle.py route', kind: 'primary', cap: 'Manifest-only scan',
        items: [
          ['folder', 'Scans aria-plugin.json index'],
          ['flag', 'Checks compliance.yaml signal'],
          ['bolt', 'Ranks regulated-prod-sdlc #1'],
        ],
        detail: {
          text: 'ARIA saves the user prompt to <code>.aria/asks/request.md</code> and runs <code>python lifecycle.py route .aria/asks/request.md</code>. The router inspects only pack manifests (never reading every file in the pack) and matches <code>regulated-sdlc</code> via <code>task_pattern</code>, keywords and workspace signals.',
          links: [['User Guide: Routing', '../expertise-packs-user-guide.html#execution'], ['Pack Checklist', '../../wiki/Pack-Checklist.md']],
        },
      },
      rows: [
        {
          node: {
            id: 'n-match', icon: 'grid', title: 'Match Pack', via: 'task_pattern + signal', kind: 'step',
            detail: {
              text: 'Matched by regex <code>\\b(regulated|infosec|uat|std-sec-2026|go-live)\\b</code> and workspace file <code>compliance.yaml</code>. Offers overlay <code>regulated-sdlc:regulated-prod-sdlc</code>.',
              links: [['Manifest JSON', '../expertise-packs-user-guide.html#templates']],
            },
          },
          note: '<b>Matches</b> manifest rules in ~1.4k tokens without reading full docs.',
        },
        {
          node: {
            id: 'n-confirm', icon: 'check', title: 'Pick @pack', via: '@pack / @core', kind: 'gate',
            detail: {
              text: 'If a pack matches, <code>lifecycle.py contract</code> refuses to proceed until the user explicitly chooses <code>@regulated-sdlc</code> or <code>@core</code>.',
              links: [['Auto vs Collab', '../expertise-packs-user-guide.html#execution']],
            },
          },
          note: '<b>Ask</b> once: run regulated SDLC overlay or stay on core.',
        },
      ],
    },
    {
      entries: [{ id: 'r-agent', icon: 'aria', label: 'Agents', to: 'm-contract' }],
      main: {
        id: 'm-contract', icon: 'terminal', title: 'Bind Contract', via: 'lifecycle.py contract', kind: 'primary', cap: 'Auto or Collab',
        items: [
          ['doc', 'Writes contract.json & plan.md'],
          ['lock', 'Copies pack skills to .aria/skills/'],
          ['users', 'Auto: gates=ticked \u00b7 Collab: scoped'],
        ],
        detail: {
          text: '<b>ARIA Auto</b> runs <code>lifecycle.py contract regulated-sdlc:regulated-prod-sdlc wire-api "ARIA Auto" .aria/asks/request.md @regulated-sdlc gates=ticked</code> and pauses only at milestones ticked in <code>plan.md</code>. <b>ARIA Collab</b> runs all stages with persona hand-offs or scopes to specific stages (<code>only=infosec-review,uat-signoff</code>).',
          links: [['Exact CLI Walkthrough', '../expertise-packs-user-guide.html#execution']],
        },
      },
      rows: [
        {
          node: {
            id: 'n-build', icon: 'api', title: 'Build & Verify', via: 'Stages 1\u20133 feature loop', kind: 'step',
            detail: {
              text: 'Runs <code>requirements</code>, <code>design</code> and <code>build</code> through locked feature checks (<code>loop.py verify</code>) with mTLS and audit correlation IDs.',
              links: [['Lifecycle Overlay JSON', '../expertise-packs-user-guide.html#templates']],
            },
          },
          chain: { id: 'c-verify', icon: 'check', title: 'loop.py verify', via: 'Exit 0 required', kind: 'gate' },
          note: '<b>Verify</b> every feature check green before review gates.',
        },
        {
          node: {
            id: 'n-brief', icon: 'doc', title: 'Stage Brief', via: 'lifecycle.py brief', kind: 'optional',
            detail: {
              text: '<code>lifecycle.py brief "regulated-sdlc:infosec-assessor" stage=infosec-review</code> injects only the stage\'s pack persona, selected skills and <code>STD-SEC-2026</code> knowledge pointer.',
              links: [['STD-SEC-2026 Standard', '../expertise-packs-user-guide.html#standard']],
            },
          },
          note: '<b>Injects</b> <code>STD-SEC-2026</code> only on stages that declare it.',
        },
      ],
    },
    {
      entries: [{ id: 'r-gates', icon: 'shield', label: 'Gates', to: 'm-gates' }],
      main: {
        id: 'm-gates', icon: 'shield', title: 'Review Gates', via: 'Stages 4\u20136 enforced', kind: 'primary', cap: 'Evidence-gated',
        items: [
          ['lock', 'Stage 4: infosec-review (STD-SEC-2026)'],
          ['cloud', 'Stage 5: uat-signoff (smoke + drill)'],
          ['flag', 'Stage 6: release & provenance.md'],
        ],
        detail: {
          text: '<code>stage_evidence.py</code> blocks <code>lifecycle.py stage &lt;name&gt; done</code> unless required templated deliverables validate cleanly via <code>manage.py</code> and feature checks pass.',
          links: [['Templates & Gates', '../expertise-packs-user-guide.html#templates']],
        },
      },
      rows: [
        {
          node: {
            id: 'n-infosec', icon: 'lock', title: 'InfoSec Review', via: 'infosec-assessor', kind: 'step',
            detail: {
              text: 'Initializes <code>manage.py init regulated-sdlc:infosecClearance --slug wire-api --session s1</code> and validates Tier-1 data classification, mTLS, workload identity and zero static secrets.',
              links: [['InfoSec Template', '../expertise-packs-user-guide.html#templates']],
            },
          },
          chain: { id: 'c-infosec', icon: 'doc', title: 'INFOSEC.md', via: 'template-valid', kind: 'gate' },
          note: '<b>Blocks</b> stage done until STD-SEC-2026 sections pass.',
        },
        {
          node: {
            id: 'n-uat', icon: 'cloud', title: 'UAT Review', via: 'uat-release-reviewer', kind: 'step',
            detail: {
              text: 'Verifies UAT environment parity, smoke suite logs and rehearsed rollback in <code>docs/compliance/UAT-SIGNOFF-{slug}.md</code>. Failed checks trigger <code>lifecycle.py rework uat-signoff</code> back to <code>build</code> (capped at 2).',
              links: [['UAT Sign-off Template', '../expertise-packs-user-guide.html#templates']],
            },
          },
          chain: { id: 'c-uat', icon: 'check', title: 'UAT-SIGNOFF.md', via: 'checks + drill', kind: 'gate' },
          note: '<b>Rework</b> loops to <code>build</code> (max 2) if parity or drill fails.',
        },
        {
          node: {
            id: 'n-ship', icon: 'flag', title: 'Sign-off & Ship', via: 'Mission Control Plan', kind: 'gate',
            detail: {
              text: 'Reviewer clicks <b>Accept</b> on ticked gates in Mission Control, composite evaluation runs (70% core + 30% pack rubrics), and <code>lifecycle.py report</code> records pack token share in <code>provenance.md</code>.',
              links: [['User Guide: Sign-off', '../expertise-packs-user-guide.html#signoff']],
            },
          },
          chain: { id: 'c-prov', icon: 'chart', title: 'provenance.md', via: 'Pack token share', kind: 'step' },
        },
      ],
    },
  ],
  panel: {
    icon: 'folder', title: 'Pack: regulated-sdlc', sub: 'Data-only folder or .ariaplugin',
    from: 'c-prov', label: 'Audits',
    nodes: [
      { id: 'p-manifest', icon: 'grid', title: 'aria-plugin.json', via: 'Routing, index & tools', href: '../expertise-packs-user-guide.html#templates' },
      { id: 'p-std', icon: 'shield', title: 'STD-SEC-2026.md', via: 'Zero-trust & Tier-1 rules', href: '../expertise-packs-user-guide.html#standard' },
      { id: 'p-tpl', icon: 'doc', title: '2 Gate Templates', via: 'InfoSec & UAT templates', href: '../expertise-packs-user-guide.html#templates' },
      { id: 'p-eval', icon: 'chart', title: 'regulated-sdlc.eval', via: '70% core + 30% pack rubrics', href: '../expertise-packs-user-guide.html#templates' },
    ],
    facts: [
      ['lock', 'Markdown &amp; JSON only \u2014 zero executable scripts or hooks inside a pack.'],
      ['chart', 'Plan &amp; <code>provenance.md</code> report always-on vs on-demand pack tokens.'],
    ],
  },
};