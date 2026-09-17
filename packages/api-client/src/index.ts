// Runtime transport shared by web and generated OpenAPI consumers.
export class ApiError extends Error{constructor(public code:string,public status:number){super(code.replaceAll('_',' '))}}
export async function request<T>(path:string,options:RequestInit={}):Promise<T>{const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers:{'Content-Type':'application/json',...options.headers}});const value=await response.json();if(!response.ok)throw new ApiError(value.error?.code??'REQUEST_FAILED',response.status);return value as T}
export type {paths} from './generated.ts';
