export type CouncilLocale = 'zh-CN' | 'en';

export type CouncilRoleKey =
  | 'archivist' | 'surveyor' | 'auditor' | 'verifier' | 'cartographer'
  | 'sentinel' | 'engineer' | 'scribe' | 'mediator' | 'strategist'
  | 'research_architect' | 'literature_strategist' | 'source_verifier' | 'methodologist'
  | 'statistical_reviewer' | 'ethics_reviewer' | 'peer_reviewer' | 'devils_advocate'
  | 'integrity_gatekeeper' | 'revision_coach' | 'academic_editor' | 'reproducibility_auditor'
  | 'visualization_reviewer' | 'research_monitor' | 'collaboration_observer'
  | 'product_manager' | 'ux_researcher' | 'data_analyst' | 'qa_engineer'
  | 'devops_engineer' | 'market_researcher' | 'prompt_evaluator' | 'requirements_analyst'
  | 'release_manager'
  | 'policy_researcher' | 'policy_analyst' | 'regulatory_monitor' | 'impact_assessor'
  | 'stakeholder_mapper' | 'policy_brief_editor' | 'consultation_reviewer'
  | 'venue_matcher' | 'submission_editor' | 'peer_response_officer'
  | 'publication_ethics_officer' | 'authorship_disclosure_officer' | 'publication_readiness_auditor'
  | 'code_archaeologist' | 'software_architect' | 'code_reviewer' | 'test_strategist'
  | 'security_engineer' | 'performance_engineer' | 'dependency_engineer' | 'api_contract_analyst'
  | 'refactoring_planner' | 'incident_investigator' | 'migration_planner' | 'accessibility_reviewer';

export type CouncilDomain = 'core' | 'academic' | 'policy' | 'publication' | 'code' | 'product';

export interface CouncilRoleDefinition {
  key: CouncilRoleKey;
  domain?: CouncilDomain;
  zhName: string;
  enName: string;
  zhScope: string;
  enScope: string;
  zhMethod: string[];
  enMethod: string[];
  zhDeliverables: string[];
  enDeliverables: string[];
  zhSkillFocus: string;
  enSkillFocus: string;
  skillHints?: string[];
}
