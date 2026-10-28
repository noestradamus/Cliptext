import {ApiError} from './server';
import {jpegDimensions} from './frame';
export const SLIDE_MAX_BYTES=500*1024;
export const SLIDE_MAX_DIMENSION=1600;
export function slideIndex(value:string){const index=Number(value);if(!Number.isInteger(index)||index<1||index>35)throw new ApiError(400,'Choose slide 1–35.');return index;}
export async function slideJpeg(request:Request){
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='image/jpeg')throw new ApiError(415,'Upload slides as JPEG images.');
  if(!request.body)throw new ApiError(400,'The slide image is empty.');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>SLIDE_MAX_BYTES){await reader.cancel();throw new ApiError(413,'A saved slide must be at most 500 KiB.');}chunks.push(part.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return {bytes,...jpegDimensions(bytes,SLIDE_MAX_DIMENSION)};
}
