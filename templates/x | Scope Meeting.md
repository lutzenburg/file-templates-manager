{{#def.select('TYPE', 'Select note type', ['note','meeting','doc'])}}
{{#def.prompt('MEETING_NO', 'What meeting is this?')}}
{{#def.prompt('KEYWORDS', 'Add some comma separated keywords')}}
---
title: {{=$.MEETING_NO}} | Scope Meeting
date: {{=$.DATE}}
id: {{=$.ID}}
keywords: [scope,{{=$.KEYWORDS}}]
type: {{=$.TYPE}}
---



