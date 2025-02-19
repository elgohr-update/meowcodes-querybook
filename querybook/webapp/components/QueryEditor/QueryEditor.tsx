import clsx from 'clsx';
import { debounce, find, throttle } from 'lodash';
import React, {
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from 'react';
import { Controlled as ReactCodeMirror } from 'react-codemirror2';

import { showTooltipFor } from 'components/CodeMirrorTooltip';
import { ICodeMirrorTooltipProps } from 'components/CodeMirrorTooltip/CodeMirrorTooltip';
import KeyMap from 'const/keyMap';
import {
    FunctionDocumentationCollection,
    tableNameDataTransferName,
} from 'const/metastore';
import { useAutoComplete } from 'hooks/queryEditor/useAutoComplete';
import { useCodeAnalysis } from 'hooks/queryEditor/useCodeAnalysis';
import { useLint } from 'hooks/queryEditor/useLint';
import CodeMirror, { CodeMirrorKeyMap } from 'lib/codemirror';
import { SQL_JINJA_MODE } from 'lib/codemirror/codemirror-mode';
import {
    AutoCompleteType,
    ExcludedTriggerKeys,
} from 'lib/sql-helper/sql-autocompleter';
import { format } from 'lib/sql-helper/sql-formatter';
import {
    ILinterWarning,
    IRange,
    IToken,
    TableToken,
} from 'lib/sql-helper/sql-lexer';
import { formatNumber } from 'lib/utils/number';
import { navigateWithinEnv } from 'lib/utils/query-string';
import { IconButton } from 'ui/Button/IconButton';
import { Icon } from 'ui/Icon/Icon';

import {
    IStyledQueryEditorProps,
    StyledQueryEditor,
} from './StyledQueryEditor';

import './QueryEditor.scss';

export interface IQueryEditorProps extends IStyledQueryEditorProps {
    options?: Record<string, unknown>;
    value?: string;

    lineWrapping?: boolean;
    readOnly?: boolean;
    language?: string;
    theme?: string;
    functionDocumentationByNameByLanguage?: FunctionDocumentationCollection;
    metastoreId?: number;
    keyMap?: CodeMirrorKeyMap;
    className?: string;
    autoCompleteType?: AutoCompleteType;

    /**
     * If provided, then the container component will handle the fullscreen logic
     */
    onFullScreen?: (fullScreen: boolean) => void;

    onChange?: (value: string) => any;
    onKeyDown?: (editor: CodeMirror.Editor, event: KeyboardEvent) => any;
    onFocus?: (editor: CodeMirror.Editor, event: React.SyntheticEvent) => any;
    onBlur?: (editor: CodeMirror.Editor, event: React.SyntheticEvent) => any;
    onSelection?: (str: string, selection: IRange) => any;
    getTableByName?: (schema: string, name: string) => any;

    getLintErrors?: (
        query: string,
        editor: CodeMirror.Editor
    ) => Promise<ILinterWarning[]>;
    onLintCompletion?: (hasError?: boolean) => void;
}

export interface IQueryEditorHandles {
    getEditor: () => CodeMirror.Editor;
    formatQuery: (options?: {
        case?: 'lower' | 'upper';
        indent?: string;
    }) => void;
    getEditorSelection: (editor?: CodeMirror.Editor) => IRange;
}

export const QueryEditor: React.FC<
    IQueryEditorProps & {
        ref: React.Ref<IQueryEditorHandles>;
    }
> = React.forwardRef<IQueryEditorHandles, IQueryEditorProps>(
    (
        {
            options = {},
            value = '',

            lineWrapping = false,
            readOnly,
            language = 'hive',
            theme = 'default',
            functionDocumentationByNameByLanguage = {},
            metastoreId,
            keyMap = {},
            className,
            autoCompleteType = 'all',
            onFullScreen,

            onChange,
            onKeyDown,
            onFocus,
            onBlur,
            onSelection,
            getTableByName,

            getLintErrors,
            onLintCompletion,
            // props from IStyledQueryEditorProps
            height = 'auto',
            fontSize,
        },
        ref
    ) => {
        const markerRef = useRef(null);
        const editorRef = useRef<CodeMirror.Editor>(null);

        const { codeAnalysis, codeAnalysisRef } = useCodeAnalysis({
            language,
            query: value,
        });
        const autoCompleter = useAutoComplete(
            metastoreId,
            autoCompleteType,
            language,
            codeAnalysis
        );

        const [fullScreen, setFullScreen] = useState(false);

        const { getLintAnnotations, lintSummary, isLinting } = useLint({
            query: value,
            editorRef,
            metastoreId,
            codeAnalysis,
            getTableByName,
            getLintErrors,
            onLintCompletion,
        });

        const openTableModal = useCallback((tableId: number) => {
            navigateWithinEnv(`/table/${tableId}/`, {
                isModal: true,
            });
        }, []);

        // Checks if token is in table, returns the table if found, false otherwise
        const isTokenInTable = useCallback(
            async (pos: CodeMirror.Position, token: CodeMirror.Token) => {
                if (codeAnalysisRef.current && token) {
                    const selectionLine = pos.line;
                    const selectionPos = {
                        from: token.start,
                        to: token.end,
                    };

                    const tableReferences: TableToken[] = [].concat.apply(
                        [],
                        Object.values(
                            codeAnalysisRef.current.lineage.references
                        )
                    );

                    let tablePosFound = null;
                    const table = find(tableReferences, (tableInfo) => {
                        if (tableInfo.line === selectionLine) {
                            const isSchemaExplicit =
                                tableInfo.end - tableInfo.start >
                                tableInfo.name.length;
                            const tablePos = {
                                from:
                                    tableInfo.start +
                                    (isSchemaExplicit
                                        ? tableInfo.schema.length
                                        : 0),
                                to: tableInfo.end,
                            };

                            if (
                                tablePos.from <= selectionPos.from &&
                                tablePos.to >= selectionPos.to
                            ) {
                                tablePosFound = tablePos;
                                return true;
                            }
                        }
                    });

                    if (table) {
                        const tableInfo = await getTableByName(
                            table.schema,
                            table.name
                        );
                        return {
                            tableInfo,
                            tablePosFound,
                        };
                    }
                }

                return false;
            },
            [getTableByName, codeAnalysisRef]
        );

        const onOpenTableModal = useCallback(
            (editor: CodeMirror.Editor) => {
                const pos = editor.getDoc().getCursor();
                const token = editor.getTokenAt(pos);

                isTokenInTable(pos, token).then((tokenInsideTable) => {
                    if (tokenInsideTable) {
                        const { tableInfo } = tokenInsideTable;
                        if (tableInfo) {
                            openTableModal(tableInfo.id);
                        }
                    }
                });
            },
            [isTokenInTable, openTableModal]
        );

        const formatQuery = useCallback(
            (
                options: {
                    case?: 'lower' | 'upper';
                    indent?: string;
                } = {}
            ) => {
                if (editorRef.current) {
                    const indentWithTabs =
                        editorRef.current.getOption('indentWithTabs');
                    const indentUnit =
                        editorRef.current.getOption('indentUnit');
                    options['indent'] = indentWithTabs
                        ? '\t'
                        : ' '.repeat(indentUnit);
                }

                const formattedQuery = format(
                    editorRef.current.getValue(),
                    language,
                    options
                );
                editorRef.current?.setValue(formattedQuery);
            },
            [language]
        );

        const markTextAndShowTooltip = (
            editor: CodeMirror.Editor,
            pos: CodeMirror.Position,
            token: IToken,
            tooltipProps: Omit<ICodeMirrorTooltipProps, 'hide'>
        ) => {
            const markTextFrom = { line: pos.line, ch: token.start };
            const markTextTo = { line: pos.line, ch: token.end };

            markerRef.current = editor
                .getDoc()
                .markText(markTextFrom, markTextTo, {
                    className: 'CodeMirror-hover',
                    clearOnEnter: true,
                });

            const markerNodes = Array.from(
                editor
                    .getScrollerElement()
                    .getElementsByClassName('CodeMirror-hover')
            );

            if (markerNodes.length > 0) {
                let direction: 'up' | 'down' = null;
                if (markerNodes.length > 1) {
                    // Since there is another marker in the way
                    // and it is very likely to be a lint marker
                    // so we show the tooltip direction to be down
                    direction = 'down';
                }

                // Sanity check
                showTooltipFor(
                    markerNodes,
                    tooltipProps,
                    () => {
                        markerRef.current?.clear();
                        markerRef.current = null;
                    },
                    direction
                );
            } else {
                // marker did not work
                markerRef.current?.clear();
                markerRef.current = null;
            }
        };

        const matchFunctionWithDefinition = useCallback(
            (functionName: string) => {
                if (
                    language &&
                    language in functionDocumentationByNameByLanguage
                ) {
                    const functionDefs =
                        functionDocumentationByNameByLanguage[language];
                    const functionNameLower = (
                        functionName || ''
                    ).toLowerCase();

                    if (functionNameLower in functionDefs) {
                        return functionDefs[functionNameLower];
                    }
                }

                return null;
            },
            [language, functionDocumentationByNameByLanguage]
        );

        const onTextHover = useMemo(
            () =>
                debounce(
                    async (editor: CodeMirror.Editor, node, e, pos, token) => {
                        if (
                            markerRef.current == null &&
                            (token.type === 'variable-2' || token.type == null)
                        ) {
                            // Check if token is inside a table
                            const tokenInsideTable = await isTokenInTable(
                                pos,
                                token
                            );

                            if (tokenInsideTable) {
                                const { tableInfo } = tokenInsideTable;
                                if (tableInfo) {
                                    markTextAndShowTooltip(editor, pos, token, {
                                        tableId: tableInfo.id,
                                        openTableModal: () =>
                                            openTableModal(tableInfo.id),
                                    });
                                } else {
                                    markTextAndShowTooltip(editor, pos, token, {
                                        error: 'Table does not exist!',
                                    });
                                }
                            }

                            const nextChar = editor.getDoc().getLine(pos.line)[
                                token.end
                            ];
                            if (nextChar === '(') {
                                // if it seems like a function call
                                const functionDef = matchFunctionWithDefinition(
                                    token.string
                                );
                                if (functionDef) {
                                    markTextAndShowTooltip(editor, pos, token, {
                                        functionDocumentations: functionDef,
                                    });
                                }
                            }
                        }
                    },
                    600
                ),
            [isTokenInTable, matchFunctionWithDefinition, openTableModal]
        );

        const showAutoCompletion = useMemo(
            () =>
                debounce((editor: CodeMirror.Editor) => {
                    (CodeMirror as any).commands.autocomplete(editor, null, {
                        completeSingle: false,
                        passive: true,
                    });
                }, 500),
            []
        );

        const getEditorSelection = useCallback((editor?: CodeMirror.Editor) => {
            editor = editor || editorRef.current;
            const selectionRange = editor
                ? {
                      from: editor.getDoc().getCursor('start'),
                      to: editor.getDoc().getCursor('end'),
                  }
                : null;

            if (
                selectionRange.from.line === selectionRange.to.line &&
                selectionRange.from.ch === selectionRange.to.ch
            ) {
                return null;
            }

            return selectionRange;
        }, []);

        useEffect(() => {
            editorRef.current?.refresh();
        }, [fullScreen]);

        useImperativeHandle(
            ref,
            () => ({
                getEditor: () => editorRef.current,
                formatQuery,
                getEditorSelection,
            }),
            [formatQuery, getEditorSelection]
        );

        const toggleFullScreen = useCallback(() => {
            setFullScreen((fullScreen) => {
                onFullScreen?.(!fullScreen);
                return !fullScreen;
            });
        }, [onFullScreen]);

        /* ---- start of <ReactCodeMirror /> properties ---- */

        const editorOptions: Record<string, unknown> = useMemo(() => {
            const lintingOptions = !readOnly
                ? {
                      lint: {
                          // Lint only when you can edit
                          getAnnotations: getLintAnnotations,
                          async: true,
                          lintOnChange: false,
                      },
                  }
                : {};

            const editorOptions = {
                mode: SQL_JINJA_MODE,
                indentWithTabs: true,
                lineWrapping,
                lineNumbers: true,
                gutters: ['CodeMirror-lint-markers'],
                extraKeys: {
                    [KeyMap.queryEditor.autocomplete.key]: 'autocomplete',
                    [KeyMap.queryEditor.indentLess.key]: 'indentLess',
                    [KeyMap.queryEditor.toggleComment.key]: 'toggleComment',
                    [KeyMap.queryEditor.swapLineUp.key]: 'swapLineUp',
                    [KeyMap.queryEditor.swapLineDown.key]: 'swapLineDown',
                    [KeyMap.queryEditor.addCursorToPrevLine.key]:
                        'addCursorToPrevLine',
                    [KeyMap.queryEditor.addCursorToNextLine.key]:
                        'addCursorToNextLine',

                    [KeyMap.queryEditor.openTable.key]: onOpenTableModal,
                    [KeyMap.queryEditor.formatQuery.key]: formatQuery,
                    ...keyMap,
                },
                indentUnit: 4,
                textHover: onTextHover,
                theme,
                matchBrackets: true,
                autoCloseBrackets: true,
                highlightSelectionMatches: true,

                // Readonly related options
                readOnly,
                cursorBlinkRate: readOnly ? -1 : 530,

                // viewportMargin: Infinity,
                ...lintingOptions,
                ...options,
            };

            return editorOptions;
        }, [
            options,
            lineWrapping,
            readOnly,
            theme,
            keyMap,
            formatQuery,
            getLintAnnotations,
            onOpenTableModal,
            onTextHover,
        ]);

        const editorDidMount = useCallback((editor: CodeMirror.Editor) => {
            editorRef.current = editor;

            // There is a strange bug where codemirror would start with the wrong height (on Execs tab)
            // which can only be solved by clicking on it
            // The current work around is to add refresh on mount
            setTimeout(() => {
                editor.refresh();
            }, 50);
        }, []);

        const onBeforeChange = useCallback(
            (editor: CodeMirror.Editor, data, value: string) => {
                if (onChange) {
                    onChange(value);
                }
            },
            [onChange]
        );

        const handleOnBlur = useCallback(
            (editor: CodeMirror.Editor, event) => {
                onBlur?.(editor, event);
            },
            [onBlur]
        );

        const handleOnCursorActivity = useMemo(
            () =>
                throttle((editor: CodeMirror.Editor) => {
                    if (onSelection) {
                        const selectionRange = getEditorSelection(editor);
                        onSelection(
                            selectionRange
                                ? editor.getDoc().getSelection()
                                : '',
                            selectionRange
                        );
                    }
                }, 1000),
            [getEditorSelection, onSelection]
        );

        const handleOnDrop = useCallback(
            (editor: CodeMirror.Editor, event: React.DragEvent) => {
                const tableNameData: string = event.dataTransfer.getData(
                    tableNameDataTransferName
                );

                if (tableNameData) {
                    editor.focus();
                    const { pageX, pageY } = event;
                    editor.setCursor(
                        editor.coordsChar({ left: pageX, top: pageY })
                    );
                    editor.replaceRange(
                        ` ${tableNameData} `,
                        editor.getCursor()
                    );
                }
            },
            []
        );

        const handleOnFocus = useCallback(
            (editor: CodeMirror.Editor, event) => {
                autoCompleter.registerHelper();

                if (onFocus) {
                    onFocus(editor, event);
                }
            },
            [onFocus, autoCompleter]
        );

        const handleOnKeyUp = useCallback(
            (editor: CodeMirror.Editor, event: KeyboardEvent) => {
                if (
                    !(
                        editor.state.completionActive &&
                        editor.state.completionActive.widget
                    ) &&
                    !ExcludedTriggerKeys[
                        (event.keyCode || event.which).toString()
                    ]
                ) {
                    showAutoCompletion(editor);
                }
            },
            [showAutoCompletion]
        );

        const handleOnKeyDown = useCallback(
            (editor: CodeMirror.Editor, event) => {
                onKeyDown?.(editor, event);
            },
            [onKeyDown]
        );
        /* ---- end of <ReactCodeMirror /> properties ---- */

        const renderLintButtons = () => {
            if (value.length === 0) {
                return null;
            }

            if (isLinting) {
                return (
                    <span className="flex-row mr8">
                        <Icon name="Loading" className="mr4" size={16} />
                        Linting
                    </span>
                );
            }

            if (lintSummary.numErrors + lintSummary.numWarnings > 0) {
                return (
                    <div
                        className="flex-row mr4"
                        title={`${formatNumber(
                            lintSummary.numErrors,
                            'error'
                        )}, ${formatNumber(lintSummary.numWarnings, 'waring')}`}
                    >
                        {lintSummary.numErrors > 0 && (
                            <span className="lint-num-errors flex-row mr4">
                                <Icon
                                    name="XOctagon"
                                    className="mr4"
                                    size={16}
                                />
                                {lintSummary.numErrors}
                            </span>
                        )}
                        {lintSummary.numWarnings > 0 && (
                            <span className="lint-num-warnings flex-row mr8">
                                <Icon
                                    name="AlertTriangle"
                                    className="mr4"
                                    size={16}
                                />
                                {lintSummary.numWarnings}
                            </span>
                        )}
                    </div>
                );
            } else if (getLintErrors) {
                return (
                    <span className="flex-row mr8 lint-passed">
                        <Icon name="CheckCircle" className="mr4" size={16} />
                        Lint Passed
                    </span>
                );
            }
        };

        const floatButtons = (
            <div className="query-editor-float-buttons-wrapper flex-row mt8 mr8">
                {renderLintButtons()}

                <IconButton
                    icon={fullScreen ? 'Minimize2' : 'Maximize2'}
                    onClick={toggleFullScreen}
                    className="full-screen-button"
                    size={16}
                    noPadding
                />
            </div>
        );

        const editorClassName = clsx({
            fullScreen: !onFullScreen && fullScreen,
            [className]: !!className,
        });

        return (
            <StyledQueryEditor
                className={editorClassName}
                height={height}
                fontSize={fontSize}
            >
                {floatButtons}
                <ReactCodeMirror
                    value={value}
                    options={editorOptions}
                    editorDidMount={editorDidMount}
                    onBeforeChange={onBeforeChange}
                    onBlur={handleOnBlur}
                    onCursorActivity={handleOnCursorActivity}
                    onDrop={handleOnDrop}
                    onFocus={handleOnFocus}
                    onKeyUp={handleOnKeyUp}
                    onKeyDown={handleOnKeyDown}
                />
            </StyledQueryEditor>
        );
    }
);
