---
name: skill-finder
description: Search and install third-party SKILL.md compatible skills from GitHub
category: system
tags:
  - md
  - third
  - party
  - search
  - skills
  - install
  - compatible
---

# Skill Discovery and Installation

## When to Use

When a task requires expertise or capabilities not covered by built-in tools, or when the user explicitly asks you to find or install a new skill.

## Trigger Keywords

skill, find skill, install skill, search skill, need skill, skill-finder

## Procedure

### Step 1: Check existing skills

Call `skill_list()` first to see if a relevant skill is already installed. No point searching for something you already have.

### Step 2: Search for skills

Use `skill_search(query="...")` with descriptive keywords:
- `skill_search(query="docker deploy")` - for containerization tasks
- `skill_search(query="python testing")` - for test frameworks
- `skill_search(query="react component")` - for frontend patterns

The search returns GitHub repositories containing SKILL.md files.

### Step 3: Evaluate results

Before installing, consider:
- Does the description match your need?
- Is the repository actively maintained?
- Does the skill require tools or APIs not available?

### Step 4: Install

Use `skill_install(url="https://github.com/user/repo")` with the GitHub URL.

The skill is immediately available after installation. No restart needed.

### Step 5: Verify

Call `skill_view(name="skill-name")` to load the full prompt template and confirm the skill is ready.

## Integration

Once installed, the skill's prompt template will be automatically injected into your system prompt when its trigger keywords match user messages. You do not need to manually load it each time.

## Limitations

- The target repository must have a SKILL.md file in its root (or one level deep)
- Only GitHub repositories are supported as install sources
- Installed skills are stored in `{workspace}/data/skills/` and synced to the database
