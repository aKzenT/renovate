import is from '@sindresorhus/is';
import Graph from 'graph-data-structure';
import minimatch from 'minimatch';
import upath from 'upath';
import { logger } from '../../../logger';
import { getFileList } from '../../../util/git';
import { readFileAsXmlDocument } from './util';

export const NUGET_CENTRAL_FILE = 'Directory.Packages.props';
export const MSBUILD_CENTRAL_FILE = 'Packages.props';

/**
 * Get all package files at any level of ancestry that depend on packageFileName
 */
export async function getDependentPackageFiles(
  packageFileName: string,
  isCentralManament = false
): Promise<string[]> {
  const packageFiles = await getAllPackageFiles();
  const graph: ReturnType<typeof Graph> = Graph();

  if (isCentralManament) {
    graph.addNode(packageFileName);
  }

  const parentDir =
    packageFileName === NUGET_CENTRAL_FILE ||
    packageFileName === MSBUILD_CENTRAL_FILE
      ? ''
      : upath.dirname(packageFileName);

  for (const f of packageFiles) {
    graph.addNode(f);

    if (isCentralManament && upath.dirname(f).startsWith(parentDir)) {
      graph.addEdge(packageFileName, f);
    }
  }

  for (const f of packageFiles) {
    const doc = await readFileAsXmlDocument(f);
    if (!doc) {
      throw new Error(`Invalid xml file: ${f}`);
    }

    const projectReferenceAttributes = doc
      .childrenNamed('ItemGroup')
      .map((ig) => ig.childrenNamed('ProjectReference'))
      .flat()
      .map((pf) => pf.attr['Include'])
      .filter(is.nonEmptyString);

    const projectReferences = projectReferenceAttributes.map((a) =>
      upath.normalize(a)
    );
    const normalizedRelativeProjectReferences = projectReferences.map((r) =>
      reframeRelativePathToRootOfRepo(f, r)
    );

    for (const ref of normalizedRelativeProjectReferences) {
      graph.addEdge(ref, f);
    }

    if (graph.hasCycle()) {
      throw new Error('Circular reference detected in NuGet package files');
    }
  }

  const dependents = recursivelyGetDependentPackageFiles(
    packageFileName,
    graph
  );

  // deduplicate
  return Array.from(new Set(dependents.reverse())).reverse();
}

/**
 * Traverse graph and find dependent package files at any level of ancestry
 */
function recursivelyGetDependentPackageFiles(
  packageFileName: string,
  graph: ReturnType<typeof Graph>
): string[] {
  const dependents = graph.adjacent(packageFileName);

  if (dependents.length === 0) {
    return [];
  }

  return dependents.concat(
    dependents.map((d) => recursivelyGetDependentPackageFiles(d, graph)).flat()
  );
}

/**
 * Take the path relative from a project file, and make it relative from the root of the repo
 */
function reframeRelativePathToRootOfRepo(
  dependentProjectRelativePath: string,
  projectReference: string
): string {
  const virtualRepoRoot = '/';
  const absoluteDependentProjectPath = upath.resolve(
    virtualRepoRoot,
    dependentProjectRelativePath
  );
  const absoluteProjectReferencePath = upath.resolve(
    upath.dirname(absoluteDependentProjectPath),
    projectReference
  );
  const relativeProjectReferencePath = upath.relative(
    virtualRepoRoot,
    absoluteProjectReferencePath
  );

  return relativeProjectReferencePath;
}

/**
 * Get a list of package files in localDir
 */
async function getAllPackageFiles(): Promise<string[]> {
  const allFiles = await getFileList();
  const filteredPackageFiles = allFiles.filter(
    minimatch.filter('*.{cs,vb,fs}proj', { matchBase: true, nocase: true })
  );

  logger.trace({ filteredPackageFiles }, 'Found package files');

  return filteredPackageFiles;
}
