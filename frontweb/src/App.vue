<template>
  <div class="app">
    <router-view />
    <button v-if="dramaId" class="assistant-launcher" type="button" @click="open = true">助手</button>
    <AgentDrawer v-if="dramaId" v-model:open="open" :drama-id="dramaId" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import AgentDrawer from '@/components/AgentDrawer.vue'

const route = useRoute()
const open = ref(false)
const assistantRoutes = new Set(['drama-detail', 'film', 'film-canvas'])
const dramaId = computed(() => {
  if (!assistantRoutes.has(route.name)) return 0
  const id = Number(route.params.id)
  return Number.isInteger(id) && id > 0 ? id : 0
})
</script>

<style>
* {
  box-sizing: border-box;
}
html, body, #app, .app {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
  transition: background 0.25s, color 0.25s;
}
.assistant-launcher {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 20;
  border: 0;
  border-radius: 999px;
  padding: 10px 16px;
  background: #1f6feb;
  color: #fff;
  cursor: pointer;
}
</style>
