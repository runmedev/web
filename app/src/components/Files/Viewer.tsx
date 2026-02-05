// TODO: Implement this once lower-level components and types are exposed via runmedev
// import { useEffect, useMemo, useRef } from "react";

// import { create } from "@bufbuild/protobuf";
// import { Box, Link, ScrollArea, Text } from "@radix-ui/themes";

// import { BlockSchema } from "../../gen/es/cassie/blocks_pb";
// import { useCell, CellContextType } from "@runmedev/react-components";

// const FileViewer = () => {
//   // The code below is using "destructuring" assignment to assign certain values from the
//   // context object return by useBlock to local variables.
//   const { useColumns } = useCell();
//   const { files } = useColumns();

//   // automatically scroll to bottom of files
//   const filesEndRef = useRef<HTMLDivElement | null>(null);
//   const scrollToBottom = () => {
//     filesEndRef.current?.scrollIntoView({ behavior: "smooth" });
//   };

//   const oneBlock = useMemo(() => {
//     let block: CellContextType = create(BlockSchema, {});

//     // N.B. Right now we don't support more than one search block
//     if (files.length > 0) {
//       block = files[files.length - 1];
//     }

//     return block;
//   }, [files]);

//   // TODO(jlewi): Why do we pass in chatBlocks as a dependency?
//   // sebastian: because otherwise it won't rerender when the block changes
//   useEffect(() => {
//     scrollToBottom();
//   }, [oneBlock]);

//   const hasSearchResults = oneBlock.fileSearchResults.length > 0;

//   return (
//     <div className="flex flex-col h-full">
//       <Text size="5" weight="bold" className="mb-2">
//         Files
//       </Text>
//       <ScrollArea type="auto" scrollbars="vertical" className="flex-1 pt-4">
//         {!hasSearchResults ? (
//           <div>
//             <div>No search results yet</div>
//             <div ref={filesEndRef} className="h-1" />
//           </div>
//         ) : (
//           <div className="grow">
//             {oneBlock.fileSearchResults.map((b) => (
//               <div key={b.FileID} className="mb-2">
//                 <Box
//                   p="2"
//                   style={{
//                     borderRadius: "6px",
//                     border: "1px solid var(--gray-5)",
//                   }}
//                 >
//                   <Text size="2" weight="medium">
//                     <Link
//                       href={b.Link}
//                       target="_blank"
//                       className="text-blue-500 hover:underline"
//                     >
//                       {b.FileName}
//                     </Link>
//                   </Text>
//                 </Box>
//               </div>
//             ))}
//             <div ref={filesEndRef} className="h-1" />
//           </div>
//         )}
//       </ScrollArea>
//     </div>
//   );
// };

// export default FileViewer;
