#!/bin/bash
# Shared helpers for agent setup scripts.
# Source this file: source /home/agent/agents/common.sh

# Slugify a name for use as a filesystem-safe identifier.
# Usage: SAFE=$(safe_name "My Capability Name")  →  "my-capability-name"
safe_name() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}

# The three writers below stream their JSON array one compact object per line
# (`jq -c '.[]'`, the same idiom the entrypoint uses for repos) and extract
# name/content per object — one `jq` per entry rather than two. `.content` is a
# single JSON string, so a compact object is always exactly one line.

# Merge INSTRUCTIONS JSON entries and write to a single markdown file.
# Always overwrites — on rebuild, we want fresh Agentor content (not duplicated appends).
# Usage: write_instructions ~/.claude/CLAUDE.md
write_instructions() {
    local output_path="$1"
    [ -z "$INSTRUCTIONS" ] && return
    local count
    count=$(echo "$INSTRUCTIONS" | jq -r 'length' 2>/dev/null || echo 0)
    [ "$count" -eq 0 ] && return

    local merged="" entry name content underline
    while IFS= read -r entry; do
        name=$(echo "$entry" | jq -r '.name')
        content=$(echo "$entry" | jq -r '.content')
        [ -n "$merged" ] && merged="${merged}

---

"
        underline=$(printf '=%.0s' $(seq 1 ${#name}))
        merged="${merged}${name}
${underline}

${content}"
    done < <(echo "$INSTRUCTIONS" | jq -c '.[]')

    mkdir -p "$(dirname "$output_path")"
    echo "$merged" > "$output_path"
}

# Write each CAPABILITIES JSON entry as a markdown SKILL.md file.
# Creates: <base_dir>/agentor-<safe-name>/SKILL.md
# Usage: write_capabilities_md ~/.claude/skills
write_capabilities_md() {
    local base_dir="$1"
    [ -z "$CAPABILITIES" ] && return
    local count
    count=$(echo "$CAPABILITIES" | jq -r 'length' 2>/dev/null || echo 0)
    [ "$count" -eq 0 ] && return

    local entry name content safe skill_dir
    while IFS= read -r entry; do
        name=$(echo "$entry" | jq -r '.name')
        content=$(echo "$entry" | jq -r '.content')
        safe=$(safe_name "$name")
        skill_dir="${base_dir}/agentor-${safe}"
        mkdir -p "$skill_dir"
        echo "$content" > "$skill_dir/SKILL.md"
    done < <(echo "$CAPABILITIES" | jq -c '.[]')
}

# Write each CAPABILITIES JSON entry as a Gemini TOML command file.
# Strips YAML frontmatter before writing.
# Creates: <dir>/agentor-<safe-name>.toml
# Usage: write_capabilities_toml ~/.gemini/commands
write_capabilities_toml() {
    local dir="$1"
    [ -z "$CAPABILITIES" ] && return
    local count
    count=$(echo "$CAPABILITIES" | jq -r 'length' 2>/dev/null || echo 0)
    [ "$count" -eq 0 ] && return

    mkdir -p "$dir"
    local entry name content safe body escaped
    while IFS= read -r entry; do
        name=$(echo "$entry" | jq -r '.name')
        content=$(echo "$entry" | jq -r '.content')
        safe=$(safe_name "$name")
        body=$(echo "$content" | sed -n '/^---$/,/^---$/!p' | sed '/./,$!d')
        escaped=$(echo "$body" | sed 's/\\/\\\\/g')
        cat > "${dir}/agentor-${safe}.toml" <<TOMLEOF
description = "${name}"
prompt = """
${escaped}
"""
TOMLEOF
    done < <(echo "$CAPABILITIES" | jq -c '.[]')
}

# Reconcile Agentor's reserved runtime-role skill without touching generic
# capabilities or user-owned skills. The role is selected by trusted container
# provisioning and captured by entrypoint.sh before request-configured
# environment values are exported.
# Usage: reconcile_role_skill worker|platform-admin|group-admin
reconcile_role_skill() {
    local role="${1:-worker}" skill_name
    case "$role" in
        platform-admin) skill_name="agentor-global-administration" ;;
        group-admin) skill_name="agentor-group-administration" ;;
        worker) skill_name="agentor-worker-runtime" ;;
        *) skill_name="agentor-worker-runtime" ;;
    esac

    local source="/home/agent/agents/role-skills/${skill_name}.md"
    local base reserved destination stage
    if [ ! -f "$source" ]; then
        # Missing trusted content must never leave a stale privileged role in
        # place. Remove only the three reserved role entries and fail closed.
        for base in "/home/agent/.claude/skills" "/home/agent/.agents/skills"; do
            for reserved in \
                agentor-global-administration \
                agentor-group-administration \
                agentor-worker-runtime; do
                rm -rf -- "${base}/${reserved}"
            done
        done
        for reserved in \
            agentor-global-administration \
            agentor-group-administration \
            agentor-worker-runtime; do
            rm -f -- "/home/agent/.gemini/commands/${reserved}.toml"
        done
        echo "[agent] Warning: built-in role skill is missing; stale role skills were removed" >&2
        return 1
    fi

    for base in "/home/agent/.claude/skills" "/home/agent/.agents/skills"; do
        mkdir -p "$base" || return 1
        stage=$(mktemp -d "${base}/.agentor-role-skill.XXXXXX") || return 1
        install -m 0644 "$source" "$stage/SKILL.md" || {
            rm -rf -- "$stage"
            return 1
        }
        for reserved in \
            agentor-global-administration \
            agentor-group-administration \
            agentor-worker-runtime; do
            destination="${base}/${reserved}"
            [ "$reserved" = "$skill_name" ] || rm -rf -- "$destination"
        done
        destination="${base}/${skill_name}"
        rm -rf -- "$destination"
        mv -- "$stage" "$destination" || {
            rm -rf -- "$stage"
            return 1
        }
    done

    # Gemini exposes the equivalent guidance as a generated command. Keep its
    # representation role-isolated as well while preserving every other command.
    local commands="/home/agent/.gemini/commands"
    local command_path description body
    mkdir -p "$commands" || return 1
    for reserved in \
        agentor-global-administration \
        agentor-group-administration \
        agentor-worker-runtime; do
        command_path="${commands}/${reserved}.toml"
        [ "$reserved" = "$skill_name" ] || rm -f -- "$command_path"
    done
    description=$(sed -n 's/^description: //p' "$source" | head -n 1)
    body=$(awk '/^---$/{markers++; next} markers >= 2 {print}' "$source" | sed 's/\\/\\\\/g')
    stage=$(mktemp "${commands}/.agentor-role-skill.XXXXXX") || return 1
    {
        printf 'description = "%s"\n' "$description"
        printf 'prompt = """\n%s\n"""\n' "$body"
    } > "$stage" || {
        rm -f -- "$stage"
        return 1
    }
    chmod 0644 "$stage" || return 1
    mv -- "$stage" "${commands}/${skill_name}.toml" || {
        rm -f -- "$stage"
        return 1
    }
}
