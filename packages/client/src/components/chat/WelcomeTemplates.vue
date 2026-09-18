<template>
  <!-- 首用引导：任务模板（阶段三-③④）
       新用户面对空输入框不知道该说什么 —— 这里给"一句话示例"，点一下填进输入框（不直接发送），
       用户能看见将要发什么、还能改。放在输入框下方而不是上方：不挤占视觉中心，但一眼可见
       （阶段三完成标准：新用户不看文档也能完成第一个任务）。 -->
  <div class="wt-wrap">
    <template v-if="!hidden">
      <div class="wt-head">
        <span class="wt-label">{{ $t('chat.welcomeTips') }}</span>
        <span class="wt-hint">{{ $t('chat.templatesHint') }}</span>
        <button class="wt-toggle" type="button" @click="setHidden(true)">
          {{ $t('chat.templatesHide') }}
        </button>
      </div>

      <div class="wt-grid">
        <button
          v-for="t in templates"
          :key="t.id"
          class="wt-card"
          type="button"
          :title="$t(`chat.tmpl_${t.id}_p`)"
          @click="pick(t)"
        >
          <span class="wt-icon" :style="{ color: `var(--${t.tone})` }">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path v-for="(d, i) in t.paths" :key="i" :d="d" />
            </svg>
          </span>
          <span class="wt-text">
            <span class="wt-title">{{ $t(`chat.tmpl_${t.id}`) }}</span>
            <span class="wt-desc">{{ $t(`chat.tmpl_${t.id}_d`) }}</span>
          </span>
        </button>
      </div>

      <p class="wt-note">{{ $t('chat.templatesWhereGoes') }}</p>
    </template>

    <!-- 收起后留一个可逆入口：只保留一行，不彻底拿走引导 -->
    <div v-else class="wt-collapsed">
      <button class="wt-toggle" type="button" @click="setHidden(false)">
        {{ $t('chat.templatesShow') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 欢迎页任务模板。刻意做成**自包含**组件：
 * - 模板数据从 data/task-templates.ts 取，文案走全局 i18n；
 * - 显隐状态自己读写 localStorage（沿用 supercrzy: 前缀），不占用 ChatView 的状态；
 * - 只对外 emit 一个 pick(prompt)，由 ChatView 决定"填输入框"还是做别的。
 * 这样 ChatView 只多几行（它的体量闸门卡在 6460 行，不能再往里堆 UI）。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_TEMPLATES, TEMPLATES_HIDDEN_KEY, resolveTemplatePrompt, type TaskTemplate } from '@/data/task-templates'

// 全局作用域：项目约定（局部作用域的 t() 在组件里取不到根级 key）
const { t } = useI18n({ useScope: 'global' })

const emit = defineEmits<{ pick: [prompt: string] }>()

const templates = ref<TaskTemplate[]>(TASK_TEMPLATES)

/** 读取显隐偏好；存储不可用（隐私模式）时按"显示"处理 —— 引导比清静重要 */
function readHidden(): boolean {
  try {
    return localStorage.getItem(TEMPLATES_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

const hidden = ref(readHidden())

function setHidden(v: boolean): void {
  hidden.value = v
  try { localStorage.setItem(TEMPLATES_HIDDEN_KEY, v ? '1' : '0') } catch { /* 忽略 */ }
}

function pick(tpl: TaskTemplate): void {
  // 文案缺失时不填 key 字符串进输入框（判定逻辑在 data 里，已被单测覆盖）
  const prompt = resolveTemplatePrompt(t, tpl.id)
  if (!prompt) return
  emit('pick', prompt)
}

/** 仅测试用：把显隐状态复位 */
defineExpose({ __hidden: hidden })
</script>

<style scoped>
.wt-wrap {
  width: 100%;
  max-width: 720px;
  margin: var(--space-lg) auto 0;
  padding: 0 var(--space-lg);
  box-sizing: border-box;
}

.wt-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
}

.wt-label {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

.wt-hint {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.wt-toggle {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-xs);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  font-family: inherit;
}
.wt-toggle:hover { color: var(--text-secondary); background: var(--bg-hover); }

.wt-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-sm);
}

/* 窄屏降列：移动端流程（阶段三-⑥）下输入框变宽，模板也要跟着降 */
@media (max-width: 900px) {
  .wt-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .wt-grid { grid-template-columns: 1fr; }
  .wt-hint { display: none; }
}

.wt-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  padding: 10px var(--space-md);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.wt-card:hover {
  border-color: var(--border-hover);
  background: var(--bg-hover);
  transform: translateY(-1px);
}
.wt-card:active { transform: none; }

.wt-icon {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.wt-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.wt-title {
  font-size: var(--text-base);
  color: var(--text-primary);
  line-height: 1.35;
}

.wt-desc {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  line-height: 1.35;
}

.wt-note {
  margin: var(--space-sm) 0 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.5;
}

.wt-collapsed {
  display: flex;
  justify-content: center;
}
.wt-collapsed .wt-toggle { margin-left: 0; }
</style>
