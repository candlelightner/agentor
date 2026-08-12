<script setup lang="ts">
import type { ContainerInfo } from '~/types';
const open = defineModel<boolean>('open', { default: false });
defineProps<{ containers: ContainerInfo[] }>();
const { groups, create, update, remove } = useWorkerGroups();
const name = ref(''); const error = ref('');
async function createGroup() { try { error.value=''; await create(name.value); name.value=''; } catch (e:any) { error.value=e?.data?.statusMessage || 'Could not create group'; } }
async function rename(group:any) { const value=prompt('Group name',group.name); if(value?.trim()) await update(group.id,{name:value}); }
async function toggle(group:any, id:string) { const ids=group.workerIds.includes(id)?group.workerIds.filter((x:string)=>x!==id):[...group.workerIds,id]; await update(group.id,{workerIds:ids}); }
</script>
<template><UModal v-model:open="open" title="Worker groups" data-testid="worker-groups"><template #body><form class="flex gap-2" @submit.prevent="createGroup"><UInput v-model="name" aria-label="Group name" placeholder="Group name"/><UButton type="submit">Create group</UButton></form><p v-if="error" class="text-red-500 text-sm">{{ error }}</p><p v-if="!groups.length" class="text-gray-500 mt-4">No worker groups yet.</p><section v-for="group in groups" :key="group.id" class="mt-4 rounded border p-3"><div class="flex justify-between"><strong>{{ group.name }}</strong><span><UButton size="xs" variant="ghost" @click="rename(group)">Rename</UButton><UButton size="xs" color="error" variant="ghost" @click="remove(group.id)">Delete</UButton></span></div><p class="text-xs text-gray-500">Deleting a group never deletes its workers.</p><label v-for="worker in containers.filter(c=>c.userId===group.userId)" :key="worker.id" class="block mt-2"><input type="checkbox" :checked="group.workerIds.includes(worker.id)" @change="toggle(group,worker.id)"> {{ worker.displayName }}</label></section></template></UModal></template>
