import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const darkMode = ref(false)
  const currentModel = ref('deepseek-v4-pro')
  const currentAgent = ref('default')
  const isConnected = ref(false)

  function toggleDarkMode() {
    darkMode.value = !darkMode.value
  }

  function setModel(model: string) {
    currentModel.value = model
  }

  function setAgent(agent: string) {
    currentAgent.value = agent
  }

  function connect() {
    isConnected.value = true
  }

  return {
    darkMode,
    currentModel,
    currentAgent,
    isConnected,
    toggleDarkMode,
    setModel,
    setAgent,
    connect,
  }
})
