import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAgentContext = defineStore('agentContext', () => {
  const episodeId = ref(null)
  const episodes = ref([])

  function setEpisodeId(id) {
    episodeId.value = id == null || id === '' ? null : Number(id)
  }

  function setEpisodes(list) {
    episodes.value = Array.isArray(list) ? list : []
  }

  function clear() {
    episodeId.value = null
    episodes.value = []
  }

  return { episodeId, episodes, setEpisodeId, setEpisodes, clear }
})
