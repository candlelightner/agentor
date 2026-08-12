import {test,expect} from '@playwright/test';
import {ManagementConfigurationCatalogDomain} from '../../orchestrator/server/utils/management-configuration-catalog-domain';

test('catalog domain declares isolated CRUD tool surface',()=>{
  const names=new ManagementConfigurationCatalogDomain().tools().map((x:any)=>x.name);
  expect(names).toContain('catalog.environments.create');
  expect(names).toContain('catalog.capabilities.delete');
  expect(names).toContain('catalog.instructions.update');
  expect(names).toContain('catalog.init-scripts.list');
});

test('catalog adapter delete calls the store with the entry id', async()=>{
  const item={id:'entry-id',name:'Owned',content:'before',builtIn:false,userId:'owner-id'};
  const deleted:string[]=[];
  const store={
    list:()=>[item],
    getById:(id:string)=>id===item.id?item:undefined,
    update:async()=>item,
    create:async()=>item,
    delete:async(id:string)=>{deleted.push(id)},
  };
  (globalThis as any).useCapabilityStore=()=>store;
  try {
    const result=await new ManagementConfigurationCatalogDomain().execute('catalog.capabilities.delete',{ownerId:'owner-id',id:'entry-id'});
    expect(result).toEqual({handled:true,result:{id:'entry-id',deleted:true}});
    expect(deleted).toEqual(['entry-id']);
  } finally {
    delete (globalThis as any).useCapabilityStore;
  }
});
