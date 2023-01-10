import { Diagnostic } from 'vscode-languageserver';
import { SyntaxNode } from 'web-tree-sitter';
import { LspDocument } from '../document';
import {findParentCommand, isCommandName, isConditionalCommand, isEnd, isError, isFunctionDefinition, isFunctionDefinitionName, isReturn, isScope, isStatement, isVariable, isVariableDefinition} from '../utils/node-types';
import { findFirstSibling, nodesGen } from '../utils/tree-sitter';
import {createDiagnostic} from './create';
import { createAllFunctionDiagnostics } from './missingFunctionName';
import { getExtraEndSyntaxError, getMissingEndSyntaxError, getUnreachableCodeSyntaxError } from './syntaxError';
import { getUniversalVariableDiagnostics } from './universalVariable';
import * as errorCodes from './errorCodes'
import {pathVariable} from './errorCodes';

export function getDiagnostics(root: SyntaxNode, doc: LspDocument) : Diagnostic[] {
    const diagnostics: Diagnostic[] = createAllFunctionDiagnostics(root, doc)
    for (const child of nodesGen(root)) { 
        const diagnostic =
            getMissingEndSyntaxError(child) ||
            getExtraEndSyntaxError(child) ||
            getUnreachableCodeSyntaxError(child) ||
            getUniversalVariableDiagnostics(child, doc);
        if (diagnostic) diagnostics.push(diagnostic)
    }
    return diagnostics
}


export function collectDiagnosticsRecursive(root: SyntaxNode, doc: LspDocument) : Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const functionNames: Set<string> = new Set();
    const variableNames: Set<string> = new Set();
    collectAllDiagnostics(root, doc, diagnostics, functionNames, variableNames);
    return diagnostics;
}


function isMissingEnd(node: SyntaxNode) : Diagnostic | null {
    const last = node.lastChild || node.lastNamedChild || node;
    return isError(node) && !isEnd(last)
        ? createDiagnostic(node, errorCodes.missingEnd)
        : null;
}

function isExtraEnd(node: SyntaxNode) : Diagnostic | null {
    return isCommandName(node) && node.text === "end" 
        ?  createDiagnostic(node, errorCodes.extraEnd)
        : null
}

function isSyntaxError(node: SyntaxNode, diagnostic: Diagnostic | null) : Diagnostic | null {
    if (!isError(node) || !!diagnostic) return diagnostic;
    return isError(node)
        ?  createDiagnostic(node, errorCodes.syntaxError)
        : null
}

function collectEndError(node: SyntaxNode, diagnostics: Diagnostic[]): boolean {
    let didAdd = false;
    let endError = isMissingEnd(node) || isExtraEnd(node)
    endError = isSyntaxError(node, endError)
    if (endError) {
        didAdd = true;
        diagnostics.push(endError)
    }
    return didAdd;
}

// check if code is reachable 
function collectFunctionsScopes(node: SyntaxNode, doc: LspDocument, diagnostic: Diagnostic[]): boolean {
    if (!isFunctionDefinition(node)) return false
    const statements = node.namedChildren.filter((c) => isStatement(c))
    let hasRets = false;
    for (const statement of statements) {
        if (hasRets) {
            diagnostic.push(createDiagnostic(statement, errorCodes.unreachableCode, doc))
            continue
        }
        // just to be safe for the time being without testing more thorough
        if (statement.type !== "if_statement") continue;
        hasRets = completeStatementCoverage(statement, [])
    }
    return hasRets
}


/**
 * @TODO: make sure you test switch statement, because I assume that this will need a minor
 * tweak, to handle recognizing the case_clause of \* or '*'
 *
 * Recursively descends, collecting return statements in each statement block. Starts with
 * root a isStatement(if/else if/else, switch/case), and then exhaustively checks if the
 * statement block returns on every path. If it does, we use the other statements, we 
 * retrieved in collecFunctionScopes (already sorted), and publish unreachable diagnostics
 * to them.
 *
 * Important, note about the fish-shell AST from tree-sitter: 
 * if_statement and switch_statement will be root nodes, but else_if_clause/else_clause/case_clause,
 * are importantly named as children nodes (or clauses). 
 */
function completeStatementCoverage(root: SyntaxNode, collection: SyntaxNode[]) {
    let shouldReturn = isReturn(root)
    for (const child of root.namedChildren) {
        const include = completeStatementCoverage(child, collection) || isReturn(child)
        if (isStatement(child) && !include) {
            return false;
        }
        shouldReturn = include || shouldReturn
    }
    if (shouldReturn) {
        collection.push(root)
    }
    return shouldReturn;
}



/**
 * 3 main cases: 
 *   1.) check for duplicate functions
 *   2.) check for first function in an autoloaded uri-path that does not match the 
 *       autoload name.
 *   3.) Will give a diagnostic for applying '__' to helper functions, for uniqueue
 *       signature across the workspace. 
 */
function collectFunctionNames(node: SyntaxNode, doc: LspDocument, diagnostics: Diagnostic[], functionNames: Set<string>) : boolean {
    let didAdd = false;
    const name : string =  node.text
    if (!isFunctionDefinitionName(node)) return didAdd;
    const needsAutoloadName = doc.isAutoLoaded() && name !== doc.getAutoLoadName()
        && !functionNames.has(name) && functionNames.size === 0
    if (functionNames.has(name)) {
        functionNames.add(name);
        diagnostics.push(createDiagnostic(node, errorCodes.duplicateFunctionName)); 
        didAdd = true
    }
    if (needsAutoloadName) {
        functionNames.add(name);
        diagnostics.push(createDiagnostic(node, errorCodes.missingAutoloadedFunctionName))
        didAdd = true
    }
    if (!needsAutoloadName && !name.startsWith('_')) {
        functionNames.add(name);
        diagnostics.push(createDiagnostic(node, errorCodes.privateHelperFunction))
        didAdd = true
    }
    return didAdd;
}



function findVariableFlagsIfSeen(node: SyntaxNode, shortOpts: string[], longOpts: string[]) : SyntaxNode | null {
    if (!isVariableDefinition(node)) return null;
    const isUniveralOption = (n: SyntaxNode) => {
        if (n.text.startsWith('--')) return  longOpts.some(opt => n.text == `--${opt}`)
        if (!n.text.startsWith('--') && n.text.startsWith('-')) return shortOpts.some(short => n.text.includes(short));
        return false
    }
    const universalFlag = findFirstSibling(node, isUniveralOption);
    return universalFlag;
}

function getPathVariable(node: SyntaxNode, document: LspDocument, seen: Set<string>): Diagnostic | null {
    let pathVariable: Diagnostic | null = null;
    if (!isVariableDefinition(node)) null;
    const pathFlag = findVariableFlagsIfSeen(node, [], ['path', 'unpath']);
    if (!pathFlag && node.text.endsWith('PATH')) {
        pathVariable = createDiagnostic(node, errorCodes.pathVariable, document)
        seen.add(node.text)
    } 
    if (pathFlag && !node.text.endsWith('PATH')) {
        pathVariable = createDiagnostic(node, errorCodes.pathFlag, document)
        seen.add(node.text)
    }
    return pathVariable
}

function getUniversalVariable(node: SyntaxNode, document: LspDocument, seen: Set<string>): Diagnostic | null {
    if (!isVariableDefinition(node)) return null ;
    let univeralFlag = findVariableFlagsIfSeen(node, ['u'], ['universal']);
    if (!univeralFlag) return null ;
    seen.add(node.text)
    return createDiagnostic(univeralFlag , errorCodes.universalVariable, document)
}

function collectVariableNames(node: SyntaxNode, document: LspDocument, diagnostics: Diagnostic[], varsSeen: Set<string>) {
    if (!isVariableDefinition(node)) return false;
    const diagnostic = getUniversalVariable(node, document, varsSeen) || getPathVariable(node, document, varsSeen)
    if (!diagnostic) return false;
    diagnostics.push(diagnostic)
    return true;
}

function collectReturnError(node: SyntaxNode, diagnostic: Diagnostic[]) {
    if (isReturn(node)) return false;
    let currentNode : SyntaxNode | null = node
    const siblings: SyntaxNode[] = []
    while (currentNode) {
        if (isStatement(currentNode)) break;
        siblings.push(currentNode)
        currentNode = currentNode.nextNamedSibling
    }
    let stillChaining = true;  // an example of chianing -> echo "$foo" ; and return 0 
    for (const sibling of siblings) {
        if (!stillChaining) {
            diagnostic.push(createDiagnostic(sibling, errorCodes.unreachableCode))
            continue;
        }
        if (stillChaining && isConditionalCommand(sibling)) {
            stillChaining = true;
            continue;
        }
        if (stillChaining && !isConditionalCommand(sibling)) {
            stillChaining = false;
            diagnostic.push(createDiagnostic(sibling, errorCodes.unreachableCode))
            continue;
        }
    }
    return true;
}

export function collectAllDiagnostics(root: SyntaxNode, doc: LspDocument, diagnostics: Diagnostic[], functionNames: Set<string>, variableNames: Set<string>) : boolean {
    let shouldAdd = collectEndError(root, diagnostics) 
        || collectFunctionNames(root, doc, diagnostics, functionNames) 
        || collectVariableNames(root, doc, diagnostics, variableNames)
        || collectFunctionsScopes(root, doc, diagnostics)
        || collectReturnError(root, diagnostics)
        //collectReturnError(root, diagnostics);
    for (const node of root.children) {
        shouldAdd = collectAllDiagnostics(node, doc, diagnostics, functionNames, variableNames);
    }
    return shouldAdd || false;
}











