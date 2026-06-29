import { apiFetch } from './client';
import type { Member, AddMemberRequest } from './types';

export function listMembers(workspaceId: string): Promise<{ members: Member[] }> {
  return apiFetch(`/workspaces/${workspaceId}/members`);
}

export function addMember(
  workspaceId: string,
  data: AddMemberRequest,
): Promise<Member> {
  return apiFetch(`/workspaces/${workspaceId}/members`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function removeMember(workspaceId: string, userId: string): Promise<void> {
  return apiFetch(`/workspaces/${workspaceId}/members/${userId}`, {
    method: 'DELETE',
  });
}

export function linkMyTelegram(
  workspaceId: string,
  telegramUserId: string,
): Promise<{ telegramUserId: string }> {
  return apiFetch(`/workspaces/${workspaceId}/members/me/telegram`, {
    method: 'PATCH',
    body: JSON.stringify({ telegramUserId }),
  });
}
