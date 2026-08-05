defineRouteMeta({openAPI:{tags:['Backups'],summary:'Get backup configuration',operationId:'getBackupConfig',responses:{200:{description:'Configuration and status'},401:{description:'Unauthorized'}}}});
import {requireAuth} from '../../utils/auth-helpers';import {useBackupManager} from '../../utils/backup-manager';
export default defineEventHandler(async(event)=>{const {user}=requireAuth(event);return (await useBackupManager().list(user.id));});
