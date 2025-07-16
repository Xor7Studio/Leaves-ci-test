/**
 * GitHub Issue 和 Project 双向同步脚本
 * 通过比较更新时间，以最近更新的为准进行同步
 */
module.exports = async ({github, context, core}) => {
    // ===== 配置项 =====
    const config = {
        // 项目配置
        bugProject: {
            owner: 'MC-XiaoHei', // 你的组织名或用户名
            number: 1 // Bug 项目编号
        },
        featureProject: {
            owner: 'MC-XiaoHei', // 你的组织名或用户名
            number: 2 // Feature 项目编号
        },

        // 标签映射配置
        typeLabels: {
            bug: ['bug', 'Bug', 'BUG', 'defect'],
            feature: ['feature', 'Feature', 'FEATURE', 'enhancement']
        },

        // 状态映射 (双向)
        statusMappings: {
            issue: {
                'status: accepted': '✅ Accepted',
                'status: awaiting merging': '⏳ Awaiting Merging',
                'status: in progress': '🔨 Working',
                'status: needs triage': '🕑 Needs Triage'
            },
            project: {
                '✅ Accepted': 'status: accepted',
                '⏳ Awaiting Merging': 'status: awaiting merging',
                '🔨 Working': 'status: in progress',
                '🕑 Needs Triage': 'status: needs triage'
            }
        },

        // 所有状态标签
        allStatusLabels: [
            'status: accepted',
            'status: awaiting merging',
            'status: in progress',
            'status: needs triage'
        ]
    };

    // ===== 事件处理 =====
    const eventName = context.eventName;
    const actionName = context.payload.action;

    console.log(`执行事件: ${eventName}.${actionName}`);

    try {
        if (eventName === 'issues') {
            // Issue 事件触发
            await handleIssueEvent();
        } else if (eventName === 'projects_v2_item' && actionName === 'edited') {
            // Project 项目编辑事件触发
            await handleProjectItemEvent();
        }
    } catch (error) {
        core.setFailed(`执行失败: ${error.message}`);
        console.error(error);
    }

    // ===== Issue 事件处理函数 =====
    async function handleIssueEvent() {
        const issue = context.payload.issue;
        const issueNumber = issue.number;
        const repo = context.payload.repository.name;
        const owner = context.payload.repository.owner.login;
        const issueLabels = issue.labels.map(label => label.name);

        console.log(`处理 Issue #${issueNumber} 事件, 标签: ${issueLabels.join(', ')}`);

        // 判断 issue 类型
        let targetProject = null;
        let targetProjectOwner = null;
        let targetProjectNumber = null;

        for (const label of issueLabels) {
            if (config.typeLabels.bug.some(bugLabel => label.toLowerCase().includes(bugLabel.toLowerCase()))) {
                targetProject = 'bug';
                targetProjectOwner = config.bugProject.owner;
                targetProjectNumber = config.bugProject.number;
                console.log(`检测到 Bug 类型 issue，对应 Bug 项目`);
                break;
            } else if (config.typeLabels.feature.some(featureLabel => label.toLowerCase().includes(featureLabel.toLowerCase()))) {
                targetProject = 'feature';
                targetProjectOwner = config.featureProject.owner;
                targetProjectNumber = config.featureProject.number;
                console.log(`检测到 Feature 类型 issue，对应 Feature 项目`);
                break;
            }
        }

        // 如果不是 Bug 或 Feature，则跳过
        if (!targetProject) {
            console.log(`Issue #${issueNumber} 不是 Bug 或 Feature 类型，跳过处理`);
            return;
        }

        // 获取 issue 的最后更新时间
        const issueUpdatedAt = new Date(issue.updated_at);

        // 确定当前状态标签
        let currentStatusLabel = null;
        for (const label of issueLabels) {
            if (config.allStatusLabels.includes(label)) {
                currentStatusLabel = label;
                break;
            }
        }

        const currentProjectStatus = currentStatusLabel ? config.statusMappings.issue[currentStatusLabel] : null;
        console.log(`当前 Issue 状态标签: ${currentStatusLabel || '无'}, 对应项目状态: ${currentProjectStatus || '无'}`);

        // 获取项目数据
        const projectData = await getProjectData(targetProjectOwner, targetProjectNumber);
        const projectId = projectData.id;

        // 获取 issue 在项目中的信息
        const itemInfo = await getIssueInProject(projectId, issueNumber, owner, repo);

        // 如果 issue 不在项目中，添加到项目
        if (!itemInfo.exists) {
            await addIssueToProject(projectId, issueNumber, owner, repo, currentProjectStatus);
            return;
        }

        // 获取项目项目的更新时间
        const projectItemUpdatedAt = itemInfo.updatedAt ? new Date(itemInfo.updatedAt) : null;

        // 比较更新时间，决定同步方向
        if (!projectItemUpdatedAt || issueUpdatedAt > projectItemUpdatedAt) {
            // Issue 更新时间更近，以 Issue 为准同步到 Project
            console.log(`Issue 更新时间 (${issueUpdatedAt.toISOString()}) 更近，以 Issue 为准同步到 Project`);
            await updateProjectStatus(projectId, itemInfo.itemId, currentProjectStatus);
        } else {
            // Project 更新时间更近，不处理（避免循环同步）
            console.log(`Project 更新时间 (${projectItemUpdatedAt.toISOString()}) 更近或相等，跳过同步`);
        }
    }

    // ===== Project 事件处理函数 =====
    async function handleProjectItemEvent() {
        // 检查是否是状态字段被修改
        const changes = context.payload.changes;
        if (!changes.field_value || !changes.field_value.field_node_id) {
            console.log('非状态字段变更，跳过处理');
            return;
        }

        // 获取项目项目信息
        const projectItemNodeId = context.payload.projects_v2_item.node_id;
        const projectNodeId = context.payload.projects_v2.node_id;

        try {
            // 获取项目项目详细信息
            const itemDetails = await getProjectItemDetails(projectNodeId, projectItemNodeId);

            if (!itemDetails) {
                console.log('无法获取项目项目详细信息，跳过处理');
                return;
            }

            const { issueNumber, repoName, repoOwner, currentLabels, projectStatus, updatedAt } = itemDetails;

            // 获取对应的 Issue 标签
            const targetStatusLabel = projectStatus ? config.statusMappings.project[projectStatus] : null;

            if (!targetStatusLabel) {
                console.log(`项目状态 "${projectStatus}" 没有对应的 Issue 标签，或状态为空`);
                return;
            }

            // 获取 Issue 详细信息
            const issueDetails = await github.rest.issues.get({
                owner: repoOwner,
                repo: repoName,
                issue_number: issueNumber
            });

            const issueUpdatedAt = new Date(issueDetails.data.updated_at);
            const projectItemUpdatedAt = new Date(updatedAt);

            // 比较更新时间，决定同步方向
            if (projectItemUpdatedAt > issueUpdatedAt) {
                // Project 更新时间更近，以 Project 为准同步到 Issue
                console.log(`Project 更新时间 (${projectItemUpdatedAt.toISOString()}) 更近，以 Project 为准同步到 Issue`);

                // 如果已经有对应标签，跳过
                if (currentLabels.includes(targetStatusLabel)) {
                    console.log(`Issue 已有标签 ${targetStatusLabel}，无需更新`);
                    return;
                }

                // 移除旧的状态标签
                const labelsToRemove = config.allStatusLabels.filter(label =>
                    currentLabels.includes(label) && label !== targetStatusLabel
                );

                for (const labelToRemove of labelsToRemove) {
                    console.log(`移除标签: ${labelToRemove}`);
                    await github.rest.issues.removeLabel({
                        owner: repoOwner,
                        repo: repoName,
                        issue_number: issueNumber,
                        name: labelToRemove
                    });
                }

                // 添加新标签
                console.log(`添加标签: ${targetStatusLabel}`);
                await github.rest.issues.addLabels({
                    owner: repoOwner,
                    repo: repoName,
                    issue_number: issueNumber,
                    labels: [targetStatusLabel]
                });

                console.log(`已成功将项目状态 "${projectStatus}" 同步到 Issue #${issueNumber} 的标签`);
            } else {
                // Issue 更新时间更近或相同，不处理
                console.log(`Issue 更新时间 (${issueUpdatedAt.toISOString()}) 更近或相等，跳过同步`);
            }
        } catch (error) {
            console.error(`同步项目状态到 Issue 标签失败: ${error.message}`);
            throw error;
        }
    }

    // ===== 辅助函数 =====

    /**
     * 获取项目数据
     */
    async function getProjectData(projectOwner, projectNumber) {
        // 尝试以组织项目查询
        const getProjectQuery = `
      query($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            id
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `;

        // 以用户项目查询
        const getUserProjectQuery = `
      query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `;

        let projectData;
        try {
            // 尝试以组织项目查询
            projectData = await github.graphql(getProjectQuery, {
                owner: projectOwner,
                number: projectNumber
            });

            if (projectData.organization?.projectV2) {
                return {
                    id: projectData.organization.projectV2.id,
                    fields: projectData.organization.projectV2.fields.nodes
                };
            }
        } catch (error) {
            console.log(`获取组织项目失败，尝试获取用户项目: ${error}`);
        }

        try {
            // 尝试以用户项目查询
            projectData = await github.graphql(getUserProjectQuery, {
                owner: projectOwner,
                number: projectNumber
            });

            if (projectData.user?.projectV2) {
                return {
                    id: projectData.user.projectV2.id,
                    fields: projectData.user.projectV2.fields.nodes
                };
            }
        } catch (error) {
            throw new Error(`获取项目数据失败: ${error}`);
        }

        throw new Error('无法获取项目数据');
    }

    /**
     * 获取 Issue 在项目中的信息
     */
    async function getIssueInProject(projectId, issueNumber, owner, repo) {
        // 获取 issue 的 node ID
        const issueData = await github.graphql(`
      query($repo: String!, $owner: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id
          }
        }
      }
    `, {
            repo: repo,
            owner: owner,
            number: issueNumber
        });

        const issueId = issueData.repository.issue.id;

        // 查询项目中是否有此 issue
        const itemsQuery = `
      query($project: ID!) {
        node(id: $project) {
          ... on ProjectV2 {
            items(first: 100) {
              nodes {
                id
                updatedAt
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field {
                        ... on ProjectV2SingleSelectField {
                          name
                        }
                      }
                    }
                  }
                }
                content {
                  ... on Issue {
                    id
                    number
                  }
                }
              }
            }
          }
        }
      }
    `;

        const items = await github.graphql(itemsQuery, {
            project: projectId
        });

        const itemNode = items.node.items.nodes.find(
            item => item.content?.number === issueNumber
        );

        if (!itemNode) {
            return { exists: false };
        }

        // 获取状态值
        let currentStatus = null;
        for (const fieldValue of itemNode.fieldValues.nodes) {
            if (fieldValue.field && fieldValue.field.name === 'Status') {
                currentStatus = fieldValue.name;
                break;
            }
        }

        return {
            exists: true,
            itemId: itemNode.id,
            currentStatus,
            updatedAt: itemNode.updatedAt
        };
    }

    /**
     * 添加 Issue 到项目
     */
    async function addIssueToProject(projectId, issueNumber, owner, repo, targetStatus) {
        // 获取 issue 的 node ID
        const issueData = await github.graphql(`
      query($repo: String!, $owner: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id
          }
        }
      }
    `, {
            repo: repo,
            owner: owner,
            number: issueNumber
        });

        const issueId = issueData.repository.issue.id;

        // 添加到项目
        const addResponse = await github.graphql(`
      mutation($project: ID!, $issue: ID!) {
        addProjectV2ItemById(input: {
          projectId: $project
          contentId: $issue
        }) {
          item {
            id
          }
        }
      }
    `, {
            project: projectId,
            issue: issueId
        });

        const itemId = addResponse.addProjectV2ItemById.item.id;
        console.log(`成功将 issue #${issueNumber} 添加到项目`);

        // 如果有目标状态，设置状态
        if (targetStatus) {
            await updateProjectStatus(projectId, itemId, targetStatus);
        }

        return itemId;
    }

    /**
     * 更新项目中的状态
     */
    async function updateProjectStatus(projectId, itemId, targetStatus) {
        if (!targetStatus) {
            console.log('没有指定目标状态，跳过更新');
            return;
        }

        // 获取项目字段信息
        const projectFieldsQuery = `
      query($project: ID!) {
        node(id: $project) {
          ... on ProjectV2 {
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `;

        const projectFields = await github.graphql(projectFieldsQuery, {
            project: projectId
        });

        // 找到状态字段
        const statusField = projectFields.node.fields.nodes.find(
            field => field.name === 'Status' || field.name === '状态'
        );

        if (!statusField) {
            console.log('找不到状态字段，无法更新状态');
            return;
        }

        // 查找对应状态选项的ID
        const statusOption = statusField.options.find(option => option.name === targetStatus);
        if (!statusOption) {
            console.log(`在项目中找不到状态选项: "${targetStatus}"`);
            return;
        }

        // 更新状态
        await github.graphql(`
      mutation($project: ID!, $item: ID!, $field: ID!, $value: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $project
          itemId: $item
          fieldId: $field
          value: { 
            singleSelectOptionId: $value
          }
        }) {
          projectV2Item {
            id
          }
        }
      }
    `, {
            project: projectId,
            item: itemId,
            field: statusField.id,
            value: statusOption.id
        });

        console.log(`已将项目中的状态设置为 "${targetStatus}"`);
    }

    /**
     * 获取项目项目的详细信息
     */
    async function getProjectItemDetails(projectNodeId, itemNodeId) {
        try {
            const itemQuery = `
        query($projectId: ID!, $itemId: ID!) {
          node(id: $projectId) {
            ... on ProjectV2 {
              item(id: $itemId) {
                id
                updatedAt
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field {
                        ... on ProjectV2SingleSelectField {
                          name
                        }
                      }
                    }
                  }
                }
                content {
                  ... on Issue {
                    number
                    repository {
                      name
                      owner {
                        login
                      }
                    }
                    labels(first: 20) {
                      nodes {
                        name
                      }
                    }
                  }
                  ... on PullRequest {
                    number
                    repository {
                      name
                      owner {
                        login
                      }
                    }
                    labels(first: 20) {
                      nodes {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

            const itemDetails = await github.graphql(itemQuery, {
                projectId: projectNodeId,
                itemId: itemNodeId
            });

            const item = itemDetails.node.item;

            // 如果不是 Issue 或 PR，返回 null
            if (!item.content) {
                return null;
            }

            let projectStatus = null;
            for (const fieldValue of item.fieldValues.nodes) {
                if (fieldValue.field && fieldValue.field.name === 'Status') {
                    projectStatus = fieldValue.name;
                    break;
                }
            }

            return {
                issueNumber: item.content.number,
                repoName: item.content.repository.name,
                repoOwner: item.content.repository.owner.login,
                currentLabels: item.content.labels.nodes.map(label => label.name),
                projectStatus: projectStatus,
                updatedAt: item.updatedAt
            };
        } catch (error) {
            console.error(`获取项目项目详细信息失败: ${error.message}`);
            return null;
        }
    }
};